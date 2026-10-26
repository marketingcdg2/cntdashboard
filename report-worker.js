const ACCOUNTS={mono:['783833721188530'],mews:['1003863749343307','1822065945093567']};
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'') && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function report(request,token,requestGraph=fetch){
 const url=new URL(request.url),project=url.searchParams.get('project'),since=url.searchParams.get('since'),until=url.searchParams.get('until');
 if(!Object.hasOwn(ACCOUNTS,project||'')||!validDate(since)||!validDate(until)||since>until||(Date.parse(until)-Date.parse(since))/86400000>366)return json({error:'เลือกโครงการและช่วงวันที่ไม่เกิน 367 วัน'},400);
 if(project==='mews')return json({error:'หยุดดึงข้อมูล Mews ชั่วคราว'},503);
 if(!token)return json({error:'ยังไม่ได้ตั้งค่า Meta access token'},503);
 try{
 const fetchedDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const completeUntil=new Date(Date.parse(fetchedDate+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const rows=[],messageRows=[];
 for(const account of ACCOUNTS[project]){
  for(const actionOnly of [false,true]){
  let next=new URL(`https://graph.facebook.com/v21.0/act_${account}/insights`);
  Object.entries({level:'ad',fields:actionOnly?'ad_id,ad_name,adset_name,campaign_name,objective,actions,date_start':'ad_id,ad_name,adset_id,adset_name,campaign_name,objective,spend,impressions,clicks,date_start',time_increment:'1',time_range:JSON.stringify({since,until}),limit:'500'}).forEach(([k,v])=>next.searchParams.set(k,v));
  let pages=0;
  while(next){
   if(++pages>40)throw new Error('รายงานมีข้อมูลมากเกินไป กรุณาลดช่วงวันที่');
   const r=await requestGraph(next,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(45000)}),body=await r.json();
   if(!r.ok||body.error)throw new Error('Meta API ไม่สามารถโหลดรายงานได้ กรุณาลองใหม่');
   if(!Array.isArray(body.data))throw new Error('Meta API ส่งข้อมูลรายงานไม่ครบ กรุณาลองใหม่');
   (actionOnly?messageRows:rows).push(...body.data);
   next=body.paging?.next?new URL(body.paging.next):null;
   if(next&&(next.hostname!=='graph.facebook.com'||next.protocol!=='https:'))throw new Error('Invalid pagination');
  }
 }
 }
 const byAdDay=new Map(rows.map(r=>[r.ad_id+'|'+r.date_start,r]));
 for(const r of messageRows){const key=r.ad_id+'|'+r.date_start;const metrics=byAdDay.get(key);if(metrics)metrics.actions=r.actions;else {const item={...r,spend:'0',impressions:'0',clicks:'0'};rows.push(item);byAdDay.set(key,item);}}
 const images={}, posts=new Map();
 const ids=[...new Set(rows.map(r=>r.ad_id).filter(Boolean))];
 const secureImage=value=>typeof value==='string'&&value.startsWith('https://')?value:null;
 async function readObjects(ids,fields){
  const endpoint=new URL('https://graph.facebook.com/v21.0/');endpoint.searchParams.set('ids',ids.join(','));endpoint.searchParams.set('fields',fields);
  const response=await requestGraph(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  const body=await response.json();return response.ok&&!body.error?body:{};
 }
 for(let offset=0;offset<ids.length;offset+=50){
  try{
   const batch=ids.slice(offset,offset+50);
   let body=await readObjects(batch,'creative{thumbnail_url,image_url,effective_object_story_id,object_story_id,object_story_spec}');
   if(!Object.keys(body).length)body=await readObjects(batch,'creative{thumbnail_url,image_url}');
   for(const [id,item] of Object.entries(body)){
    const creative=item.creative||{}, spec=creative.object_story_spec||{};
    const image=[creative.image_url,spec.link_data?.picture,spec.video_data?.image_url,creative.thumbnail_url].map(secureImage).find(Boolean);
    if(image)images[id]=image;
    const post=creative.effective_object_story_id||creative.object_story_id;
    if(post){if(!posts.has(post))posts.set(post,[]);posts.get(post).push(id);}
   }
  }catch{/* Keep metrics even when creative media is unavailable. */}
 }
 const postIds=[...posts.keys()];
 for(let offset=0;offset<postIds.length;offset+=50){
  try{
   const body=await readObjects(postIds.slice(offset,offset+50),'full_picture,attachments{media,subattachments{media}}');
   for(const [post,item] of Object.entries(body)){
    const attachments=item.attachments?.data||[];
    const image=[item.full_picture,...attachments.flatMap(a=>[a.media?.image?.src,...(a.subattachments?.data||[]).map(child=>child.media?.image?.src)])].map(secureImage).find(Boolean);
    if(image)for(const id of posts.get(post)||[])images[id]=image;
   }
  }catch{/* Fall back to the creative thumbnail; never drop report rows. */}
 }
 const normalized=rows.map(r=>({id:r.ad_id,image:images[r.ad_id]||null,name:r.ad_name,group:r.adset_name,campaign:r.campaign_name,date:r.date_start,objective:r.objective,spend:Number(r.spend)||0,impressions:Number(r.impressions)||0,clicks:Number(r.clicks)||0,messages:Number((r.actions||[]).find(a=>a.action_type==='onsite_conversion.messaging_conversation_started_7d')?.value)||0,platform:'meta'}));
 const daily=new Map();for(const r of normalized){const d=daily.get(r.date)||{date:r.date,spend:0,impressions:0,clicks:0,messages:0};for(const k of ['spend','impressions','clicks','messages'])d[k]+=r[k];daily.set(r.date,d);}
 return json({campaigns:normalized.map(r=>({...r,name:r.campaign})),groups:normalized.map(r=>({...r,name:r.group})),creatives:normalized,daily:[...daily.values()],platform:'meta',coverage:{since,until,availableUntil:fetchedDate,completeUntil}});
 }catch(error){return json({error:error.message},502);}
}
