const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const keys=['project','platform','scope','name','date'];
const metrics=['qualify','nonQualify','clickLine'];
const validDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function validResult(row){return row && row.project==='mono' && row.platform==='meta' && ['group','creative'].includes(row.scope) && typeof row.name==='string' && row.name.trim().length>0 && row.name.length<=500 && validDate(row.date) && row.date<=today() && metrics.every(k=>Number.isSafeInteger(row[k])&&row[k]>=0&&row[k]<=1e8) && Number.isSafeInteger(row.version??0) && (row.version??0)>=0;}
const values=row=>[...keys,...metrics].map(k=>row[k]);
export async function resultStore(request,db,actor){
 const url=new URL(request.url);
 if(!db)return json({error:'ยังไม่พร้อมเชื่อมต่อฐานข้อมูล'},503);
 if(!actor)return json({error:'กรุณาเข้าสู่ระบบ',authRequired:true},401);
 try{
  if(request.method==='GET' && url.pathname==='/api/manual-results'){
   const project=url.searchParams.get('project');if(project!=='mono')return json({error:'โครงการนี้หยุดใช้งานชั่วคราว'},400);
   const result=await db.prepare('SELECT project,platform,scope,name,date,qualify,nonQualify,clickLine,version,updated_at FROM manual_results WHERE project=? ORDER BY date,name').bind(project).all();
   return json({data:result.results,writable:true});
  }
  if(!['PUT','POST'].includes(request.method))return json({error:'Method not allowed'},405);
  const origin=request.headers.get('Origin');
  if(origin!==url.origin)return json({error:'Invalid request origin'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'Expected JSON'},415);
  const raw=await request.text();if(raw.length>250000)return json({error:'ข้อมูลมีขนาดใหญ่เกินไป'},413);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'ข้อมูลไม่ถูกต้อง'},400);}
  if(request.method==='PUT' && url.pathname==='/api/manual-results'){
   if(!validResult(body)||!Number.isSafeInteger(body.version))return json({error:'ข้อมูลไม่ถูกต้อง'},400);
   const row=await db.prepare(`INSERT INTO manual_results(project,platform,scope,name,date,qualify,nonQualify,clickLine,version,updated_by)
    SELECT ?,?,?,?,?,?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM manual_results WHERE project=? AND platform=? AND scope=? AND name=? AND date=?)
    ON CONFLICT(project,platform,scope,name,date) DO UPDATE SET qualify=excluded.qualify,nonQualify=excluded.nonQualify,clickLine=excluded.clickLine,version=manual_results.version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=excluded.updated_by
    WHERE manual_results.version=? RETURNING project,platform,scope,name,date,qualify,nonQualify,clickLine,version,updated_at`).bind(...values(body),actor,body.version,...keys.map(k=>body[k]),body.version).first();
   if(!row)return json({error:'ข้อมูลถูกแก้ไขจากเครื่องอื่น กรุณาโหลดรายการล่าสุดก่อนบันทึก',conflict:true},409);
   return json({data:row});
  }
  if(request.method==='POST' && url.pathname==='/api/manual-results/import'){
   if(typeof body.deviceId!=='string'||!/^[a-f0-9-]{36}$/.test(body.deviceId)||!Array.isArray(body.rows)||body.rows.length>10||!body.rows.every(validResult))return json({error:'ข้อมูลนำเข้าไม่ถูกต้อง'},400);
   const statements=[];
   for(const row of body.rows){
    statements.push(db.prepare(`INSERT INTO manual_results_imports(device_id,project,platform,scope,name,date,qualify,nonQualify,clickLine) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(body.deviceId,...values(row)));
    statements.push(db.prepare(`INSERT INTO manual_results(project,platform,scope,name,date,qualify,nonQualify,clickLine,version,updated_by) VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT DO NOTHING`).bind(...values(row),actor));
   }
   if(statements.length)await db.batch(statements);
   return json({imported:true});
  }
  return json({error:'Not found'},404);
 }catch{ return json({error:'เชื่อมต่อฐานข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง'},503); }
}
