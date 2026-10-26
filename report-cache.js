import {report} from './report-worker.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const shift=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const today=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const dateValid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export async function cachedReport(request,env,token,fetchReport=report,now=Date.now()){
 const url=new URL(request.url),project=url.searchParams.get('project'),since=url.searchParams.get('since'),until=url.searchParams.get('until'),refresh=url.searchParams.get('refresh')==='1';
 if(project==='mews')return json({error:'หยุดดึงข้อมูล Mews ชั่วคราว'},503);
 if(project!=='mono'||!dateValid(since)||!dateValid(until)||since>until||until>today(now)||(Date.parse(until)-Date.parse(since))/86400000>366)return json({error:'เลือกโครงการและช่วงวันที่ไม่เกิน 367 วัน'},400);
 if(!env.RESULTS_DB)return json({error:'ยังไม่พร้อมเชื่อมต่อฐานข้อมูลรายงาน'},503);
 try{
  const db=env.RESULTS_DB,dates=[];for(let d=since;d<=until;d=shift(d))dates.push(d);
  const stored=await db.prepare('SELECT date,payload,fetched_at,complete FROM meta_report_days WHERE project=? AND date>=? AND date<=? AND schema_version=1').bind(project,since,until).all();
  const cached=new Map();
  for(const item of stored.results){try{const rows=JSON.parse(item.payload);if(Array.isArray(rows)&&rows.every(r=>r.date===item.date))cached.set(item.date,{...item,rows});}catch{}}
  const missing=dates.filter(d=>refresh||!cached.has(d)||(!cached.get(d).complete&&(d<today(now)||now-cached.get(d).fetched_at>300000)));
  const ranges=[];for(const d of missing){const last=ranges.at(-1);if(last&&shift(last[1])===d)last[1]=d;else ranges.push([d,d]);}
  const updates=[];
  for(const [start,end] of ranges){
   const upstream=new URL(url);upstream.searchParams.set('since',start);upstream.searchParams.set('until',end);
   const response=await fetchReport(new Request(upstream),token);if(!response.ok)return response;
   const data=await response.json();if(!Array.isArray(data.creatives)||!data.coverage)throw new Error('Invalid upstream report');
   for(let d=start;d<=end;d=shift(d)){
    const rows=data.creatives.filter(r=>r.date===d),complete=Number(d<=data.coverage.completeUntil);
    const item={date:d,rows,fetched_at:now,complete};cached.set(d,item);
    updates.push([project,d,JSON.stringify(rows),now,complete]);
   }
  }
  const writes=[];
  for(let i=0;i<updates.length;i+=20){const chunk=updates.slice(i,i+20);writes.push(db.prepare('INSERT INTO meta_report_days(project,date,payload,fetched_at,complete,schema_version) VALUES '+chunk.map(()=>'(?,?,?,?,?,1)').join(',')+' ON CONFLICT(project,date) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,complete=excluded.complete,schema_version=1 WHERE excluded.fetched_at>=meta_report_days.fetched_at').bind(...chunk.flat()));}
  if(writes.length)await db.batch(writes);
  const rows=dates.flatMap(d=>cached.get(d).rows),daily=dates.filter(date=>cached.get(date).complete || cached.get(date).rows.length).map(date=>{const sum={date,spend:0,impressions:0,clicks:0,messages:0};for(const row of cached.get(date).rows)for(const k of ['spend','impressions','clicks','messages'])sum[k]+=Number(row[k])||0;return sum;});
  // A successful request confirms historical zero days; today remains incomplete.
  const completeUntil=new Date(Date.parse(today(now)+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  return json({campaigns:rows.map(r=>({...r,name:r.campaign})),groups:rows.map(r=>({...r,name:r.group})),creatives:rows,daily,platform:'meta',coverage:{since,until,availableUntil:today(now),completeUntil},cache:{hitDays:dates.length-missing.length,fetchedDays:missing.length,storedDays:dates.length}});
 }catch{return json({error:'อ่านหรือบันทึกฐานข้อมูลรายงานไม่สำเร็จ กรุณาลองอีกครั้ง'},503);}
}
