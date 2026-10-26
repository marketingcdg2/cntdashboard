const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const customer='3725741709';
const sections=['campaigns','groups','creatives','keywords','daily'];
const day=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const shift=(d,n=1)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
let access;
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function token(env){
 const key=JSON.parse(env.GOOGLE_ADS_SERVICE_ACCOUNT||'{}');
 if(!key.private_key||!key.client_email)throw Error('GOOGLE_NOT_CONFIGURED');
 if(access?.email===key.client_email&&access.exp>Date.now()+60000)return access.value;
 const now=Math.floor(Date.now()/1000),part=x=>b64(enc.encode(JSON.stringify(x)));
 const input=part({alg:'RS256',typ:'JWT'})+'.'+part({iss:key.client_email,scope:'https://www.googleapis.com/auth/adwords',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
 const der=Uint8Array.from(atob(key.private_key.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
 const signing=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signing,enc.encode(input));
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:input+'.'+b64(new Uint8Array(signature))}),signal:AbortSignal.timeout(25000)});
 const result=await response.json();if(!response.ok||!result.access_token)throw Error('GOOGLE_AUTH_FAILED');
 access={email:key.client_email,value:result.access_token,exp:Date.now()+Number(result.expires_in||3600)*1000};return access.value;
}
async function query(env,gaql){
 const bearer=await token(env);
 const response=await fetch(`https://googleads.googleapis.com/v25/customers/${customer}/googleAds:searchStream`,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({query:gaql}),signal:AbortSignal.timeout(60000)});
 const result=await response.json();if(!response.ok){const codes=(result.error?.details||[]).flatMap(d=>(d.errors||[]).flatMap(e=>Object.values(e.errorCode||{}))).filter(c=>typeof c==='string'&&/^[A-Z_]+$/.test(c));throw Error(codes[0]||'GOOGLE_REQUEST_FAILED');}
 if(!Array.isArray(result)||result.some(p=>p.results&&!Array.isArray(p.results)))throw Error('GOOGLE_INVALID_REPORT');
 return result.flatMap(p=>p.results||[]);
}
export async function fetchGoogleReport(env,since,until,run=q=>query(env,q)){
 const metric='segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions',filter=`segments.date BETWEEN '${since}' AND '${until}'`;
 const base='campaign.id, campaign.name, campaign.advertising_channel_type';
 const [campaigns,groups,creatives,keywords]=await Promise.all([
 run(`SELECT customer.currency_code, customer.time_zone, ${base}, ${metric} FROM campaign WHERE ${filter}`),
 run(`SELECT ${base}, ad_group.id, ad_group.name, ${metric} FROM ad_group WHERE ${filter}`),
 run(`SELECT ${base}, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ${metric} FROM ad_group_ad WHERE ${filter}`),
 run(`SELECT ${base}, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ${metric} FROM keyword_view WHERE ${filter}`)
 ]);
 const normalize=r=>{if(!valid(r.segments?.date)||r.segments.date<since||r.segments.date>until)throw Error('GOOGLE_INVALID_DATE');
 const m=r.metrics||{},n=v=>{const x=Number(v||0);if(!Number.isFinite(x))throw Error('GOOGLE_INVALID_METRIC');return x;};
 return {project:'mono',platform:'google',date:r.segments.date,campaign:String(r.campaign.name),campaignId:String(r.campaign.id),objective:r.campaign.advertisingChannelType||'SEARCH',group:r.adGroup?.name||'',adgroup:r.adGroup?.name||'',spend:n(m.costMicros)/1e6,impressions:n(m.impressions),clicks:n(m.clicks),conversions:n(m.conversions),messages:0};};
 if(campaigns.some(r=>r.customer?.currencyCode!=='THB'||r.customer?.timeZone!=='Asia/Bangkok'))throw Error('GOOGLE_ACCOUNT_SETTINGS_MISMATCH');
 const result={campaigns:campaigns.map(r=>({...normalize(r),name:r.campaign.name,id:String(r.campaign.id)})),groups:groups.map(r=>({...normalize(r),name:r.adGroup.name,id:String(r.adGroup.id)})),creatives:creatives.map(r=>({...normalize(r),id:String(r.adGroupAd.ad.id),name:r.adGroupAd.ad.name||`Google Ad ${r.adGroupAd.ad.id}`,image:null})),keywords:keywords.map(r=>({...normalize(r),id:String(r.adGroupCriterion.criterionId),name:r.adGroupCriterion.keyword.text,matchType:r.adGroupCriterion.keyword.matchType})),daily:[]};
 const daily=new Map();for(const r of result.campaigns){const row=daily.get(r.date)||{date:r.date,spend:0,impressions:0,clicks:0,conversions:0,messages:0};for(const k of ['spend','impressions','clicks','conversions'])row[k]+=r[k];daily.set(r.date,row);}result.daily=[...daily.values()];return result;
}
export async function googleReport(request,env,fetchReport=fetchGoogleReport,now=Date.now()){
 const url=new URL(request.url),project=url.searchParams.get('project'),since=url.searchParams.get('since'),until=url.searchParams.get('until'),refresh=url.searchParams.get('refresh')==='1',today=day(now);
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 if(project!=='mono'||!valid(since)||!valid(until)||since>until||until>today||(Date.parse(until)-Date.parse(since))/86400000>366)return json({error:'เลือกโครงการ Mono และช่วงวันที่ไม่เกิน 367 วัน'},400);
 if(!env.RESULTS_DB)return json({error:'ยังไม่พร้อมเชื่อมต่อฐานข้อมูล Google Ads'},503);
 try{
 const dates=[];for(let d=since;d<=until;d=shift(d))dates.push(d);
 const saved=await env.RESULTS_DB.prepare('SELECT date,payload,fetched_at,complete FROM google_report_days WHERE customer_id=? AND date>=? AND date<=? AND schema_version=1').bind(customer,since,until).all();
 const cache=new Map();for(const row of saved.results){try{const data=JSON.parse(row.payload);if(sections.every(k=>Array.isArray(data[k])&&data[k].every(r=>r.date===row.date)))cache.set(row.date,{...row,data});}catch{}}
 const missing=dates.filter(d=>refresh||!cache.has(d)||(!cache.get(d).complete&&(d<today||now-cache.get(d).fetched_at>300000)));
 const ranges=[];for(const d of missing){const r=ranges.at(-1);if(r&&shift(r[1])===d)r[1]=d;else ranges.push([d,d]);}
 const updates=[];for(const [start,end] of ranges){const fresh=await fetchReport(env,start,end);if(!sections.every(k=>Array.isArray(fresh[k])))throw Error('GOOGLE_INVALID_REPORT');for(let d=start;d<=end;d=shift(d)){const data=Object.fromEntries(sections.map(k=>[k,fresh[k].filter(r=>r.date===d)]));const complete=Number(d<today);if(!data.daily.length&&complete)data.daily=[{date:d,spend:0,impressions:0,clicks:0,conversions:0,messages:0}];cache.set(d,{data,complete,fetched_at:now});updates.push([customer,d,JSON.stringify(data),now,complete]);}}
 const writes=[];for(let i=0;i<updates.length;i+=20){const rows=updates.slice(i,i+20);writes.push(env.RESULTS_DB.prepare('INSERT INTO google_report_days(customer_id,date,payload,fetched_at,complete,schema_version) VALUES '+rows.map(()=>'(?,?,?,?,?,1)').join(',')+' ON CONFLICT(customer_id,date) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,complete=excluded.complete,schema_version=1 WHERE excluded.fetched_at>=google_report_days.fetched_at').bind(...rows.flat()));}if(writes.length)await env.RESULTS_DB.batch(writes);
 return json({...Object.fromEntries(sections.map(k=>[k,dates.flatMap(d=>cache.get(d).data[k])])),platform:'google',coverage:{since,until,availableUntil:today,completeUntil:shift(today,-1)},cache:{hitDays:dates.length-missing.length,fetchedDays:missing.length,storedDays:dates.length}});
 }catch(error){const code=/^[A-Z_]+$/.test(error.message)?error.message:'GOOGLE_STORAGE_OR_NETWORK_ERROR';return json({error:`โหลดรายงาน Google Ads ไม่สำเร็จ (${code})`},503);}
}
