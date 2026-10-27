const ACCOUNT='783833721188530';
export const OBJECTIVE_SCHEMA=`CREATE TABLE IF NOT EXISTS meta_objective_ranges (project TEXT NOT NULL,since TEXT NOT NULL,until TEXT NOT NULL,payload TEXT NOT NULL,fetched_at INTEGER NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(project,since,until))`;
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function objectiveSummary(since,until,token,requestGraph=fetch){
 async function read(params){
  let url=new URL(`https://graph.facebook.com/v21.0/act_${ACCOUNT}/insights`);
  for(const [k,v] of Object.entries({...params,time_range:JSON.stringify({since,until}),limit:'500'}))url.searchParams.set(k,v);
  const rows=[];let pages=0;
  while(url){
   if(++pages>40)throw Error('ข้อมูลแคมเปญมากเกินไป');
   const response=await requestGraph(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(45000)});
   const data=await response.json();
   if(!response.ok||data.error||!Array.isArray(data.data))throw Error('โหลด Reach และคลิกลิงก์จาก Meta ไม่สำเร็จ');
   rows.push(...data.data);url=data.paging?.next?new URL(data.paging.next):null;
   if(url&&(url.hostname!=='graph.facebook.com'||url.protocol!=='https:'))throw Error('Invalid pagination');
  }
  return rows;
 }
 const campaigns=await read({level:'campaign',fields:'campaign_id,objective'});
 const types={awareness:['OUTCOME_AWARENESS','BRAND_AWARENESS','REACH'],traffic:['OUTCOME_TRAFFIC','LINK_CLICKS']};
 const entries=await Promise.all(Object.entries(types).map(async([key,objectives])=>{
  const ids=[...new Set(campaigns.filter(r=>objectives.includes(r.objective)).map(r=>r.campaign_id))];
  if(!ids.length)return [key,{reach:0,linkClicks:0}];
  const rows=await read({level:'account',fields:'reach,inline_link_clicks',filtering:JSON.stringify([{field:'campaign.id',operator:'IN',value:ids}])});
  if(rows.length>1)throw Error('Meta ส่ง Reach รวมไม่ถูกต้อง');
  const row=rows[0];
  if(!row)return [key,{reach:0,linkClicks:0}];
  const reach=Number(row.reach),linkClicks=Number(row.inline_link_clicks||0);
  if(!Number.isFinite(reach)||reach<0||!Number.isFinite(linkClicks)||linkClicks<0)throw Error('Meta ส่ง Reach ไม่ครบ');
  return [key,{reach,linkClicks}];
 }));
 return Object.fromEntries(entries);
}
export async function withObjectives(request,env,token,getReport,fetchSummary=objectiveSummary,now=Date.now()){
 const response=await getReport();if(!response.ok)return response;
 const data=await response.json(),url=new URL(request.url),since=url.searchParams.get('since'),until=url.searchParams.get('until');
 try{
  const db=env.RESULTS_DB;await db.prepare(OBJECTIVE_SCHEMA).run();
  const cached=await db.prepare('SELECT payload,fetched_at,complete FROM meta_objective_ranges WHERE project=? AND since=? AND until=?').bind('mono',since,until).first();
  let summary;
  if(cached&&url.searchParams.get('refresh')!=='1'&&(cached.complete||now-cached.fetched_at<=300000)){try{summary=JSON.parse(cached.payload);}catch{}}
  if(!summary){
   summary=await fetchSummary(since,until,token);
   const complete=Number(until<=data.coverage.completeUntil);
   await db.prepare('INSERT INTO meta_objective_ranges(project,since,until,payload,fetched_at,complete) VALUES(?,?,?,?,?,?) ON CONFLICT(project,since,until) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,complete=excluded.complete WHERE excluded.fetched_at>=meta_objective_ranges.fetched_at').bind('mono',since,until,JSON.stringify(summary),now,complete).run();
  }
  return json({...data,objectives:summary});
 }catch{return json({error:'โหลด Reach และคลิกลิงก์ไม่สำเร็จ กรุณาลองอีกครั้ง'},503);}
}
