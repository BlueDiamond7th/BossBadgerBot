import { randomUUID } from 'node:crypto';
import { requireRule } from './errors.js';
import { requireEditable } from './access.js';

const DAY=86400_000,WEEK=7*DAY,KST=9*3600_000;
export const scheduleDate=at=>new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});
export function parseScheduleTime(input,now=Date.now()) {
  const s=String(input??'').trim(),today=new Date(now+KST).toISOString().slice(0,10);
  const m=s.match(/^(?:(\d{4}-\d{2}-\d{2})|(오늘|내일)|([일월화수목금토])(?:요일)?)\s+(\d{1,2}):(\d{2})$/);
  requireRule(m,'시간은 오늘 22:00, 토 21:30 또는 2026-11-21 22:00처럼 입력해 주세요.');
  const hour=Number(m[4]),minute=Number(m[5]);requireRule(hour<24&&minute<60,'시각은 00:00~23:59로 입력해 주세요.');
  let day=m[1]??today;
  if(m[2]==='내일') day=new Date(Date.parse(`${today}T00:00:00Z`)+DAY).toISOString().slice(0,10);
  let at=Date.parse(`${day}T${String(hour).padStart(2,'0')}:${m[5]}:00+09:00`);
  requireRule(Number.isFinite(at)&&new Date(at+KST).toISOString().slice(0,10)===day,'실제 존재하는 날짜를 입력해 주세요.');
  if(m[3]) {at+=('일월화수목금토'.indexOf(m[3])-new Date(now+KST).getUTCDay()+7)%7*DAY;if(at<=now) at+=WEEK;}
  requireRule(at>now,'이미 지난 시간이에요. 앞으로 출발할 시간을 입력해 주세요.');
  requireRule(at<=now+90*DAY,'일정은 앞으로 90일 이내로 등록해 주세요.');
  return at;
}
const short=(v,max=200)=>String(v??'').trim().slice(0,max);
const terminal=s=>['cancelled','elapsed'].includes(s.status);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ids=s=>s.members.map(m=>m.userId);
export class ScheduleService {
  constructor({repository,service,now=()=>Date.now()}) {
    this.db=repository.db;this.partyService=service;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,party_id TEXT NOT NULL,series_id TEXT,original_at INTEGER NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,revision INTEGER NOT NULL,rendered INTEGER NOT NULL DEFAULT 0,message_id TEXT,data_json TEXT NOT NULL,UNIQUE(series_id,original_at));
      CREATE INDEX IF NOT EXISTS schedule_scope ON schedules(guild_id,thread_id,start_at);
      CREATE TABLE IF NOT EXISTS schedule_series(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_drafts(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_receipts(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_edits(id INTEGER PRIMARY KEY,schedule_id TEXT NOT NULL,user_id TEXT NOT NULL,at INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_jobs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',data_json TEXT NOT NULL,error TEXT);
      CREATE INDEX IF NOT EXISTS schedule_jobs_due ON schedule_jobs(state,due_at);`);
  }
  transaction(ctx,rid,action,fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT * FROM schedule_receipts WHERE id=?').get(rid);
      if(old) {requireRule(old.guild_id===ctx.guildId&&old.thread_id===ctx.threadId&&old.user_id===ctx.userId&&old.action===action,'이 요청을 다시 사용할 수 없어요.','FORBIDDEN');this.db.exec('COMMIT');return JSON.parse(old.result_json);}
      const result=fn();
      this.db.prepare('INSERT INTO schedule_receipts VALUES(?,?,?,?,?,?)').run(rid,ctx.guildId,ctx.threadId,ctx.userId,action,JSON.stringify(result??null));
      this.db.exec('COMMIT');return result;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  party(ctx,pid) {return this.partyService.getParty(ctx,pid);}
  manager(ctx,s) {return requireEditable(ctx,this.partyService.getParty(ctx,s.partyId,true));}
  members(ctx,p) {
    const state=this.partyService.snapshot(ctx),members=p.characterIds.map(id=>state.characters.find(c=>c.id===id&&c.active));
    requireRule(members.length&&members.every(Boolean),'활성 캐릭터가 있는 파티에서 일정을 등록해 주세요.');
    return members.map(c=>({characterId:c.id,userId:c.ownerId,name:c.name}));
  }
  get(ctx,id) {
    const row=this.db.prepare('SELECT * FROM schedules WHERE id=? AND guild_id=? AND thread_id=?').get(id,ctx.guildId,ctx.threadId);
    requireRule(row,'이 채널의 일정을 찾을 수 없어요.','NOT_FOUND');return {...JSON.parse(row.data_json),messageId:row.message_id};
  }
  series(ctx,id) {
    const r=this.db.prepare('SELECT * FROM schedule_series WHERE id=? AND guild_id=? AND thread_id=?').get(id,ctx.guildId,ctx.threadId);
    requireRule(r,'정기 일정을 찾을 수 없어요.','NOT_FOUND');return JSON.parse(r.data_json);
  }
  _series(ctx,s) {this.db.prepare('INSERT INTO schedule_series VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(s.id,ctx.guildId,ctx.threadId,JSON.stringify(s));}
  list(ctx,{mine=false,offset=0,partyId=null,past=false}={}) {
    const rows=this.db.prepare('SELECT id FROM schedules WHERE guild_id=? AND thread_id=? ORDER BY start_at,id').all(ctx.guildId,ctx.threadId);
    return rows.map(r=>this.get(ctx,r.id)).filter(s=>(!partyId||s.partyId===partyId)&&(!mine||ids(s).includes(ctx.userId))&&(past?(terminal(s)||s.endAt<=this.now()):(!terminal(s)&&s.endAt>this.now()&&s.startAt<this.now()+(7+offset)*DAY&&s.startAt>=this.now()+Math.max(0,offset)*DAY-(offset===0?DAY:0))));
  }
  _save(ctx,s,before=null) {
    s.revision=(s.revision??0)+1;
    this.db.prepare(`INSERT INTO schedules(id,guild_id,thread_id,party_id,series_id,original_at,start_at,end_at,status,version,revision,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET series_id=excluded.series_id,start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,version=excluded.version,revision=excluded.revision,data_json=excluded.data_json`).run(s.id,ctx.guildId,ctx.threadId,s.partyId,s.seriesId??null,s.originalAt,s.startAt,s.endAt,s.status,s.version,s.revision,JSON.stringify(s));
    if(before) this.db.prepare('INSERT INTO schedule_edits(schedule_id,user_id,at,before_json,after_json) VALUES(?,?,?,?,?)').run(s.id,ctx.userId,this.now(),JSON.stringify(before),JSON.stringify(s));
    this._reminder(s);
    return this.get(ctx,s.id);
  }
  _job(s,kind,due,data={},suffix='') {
    this.db.prepare('INSERT OR IGNORE INTO schedule_jobs(id,schedule_id,version,kind,due_at,data_json) VALUES(?,?,?,?,?,?)').run(`${s.id}:${s.version}:${kind}:${suffix}`,s.id,s.version,kind,due,JSON.stringify(data));
  }
  _reminder(s) {
    if(s.status==='confirmed'&&s.reminder&&s.startAt-this.now()>s.reminder*60_000) this._job(s,'reminder',s.startAt-s.reminder*60_000);
  }
  _new(ctx,p,options) {
    const s={id:randomUUID(),partyId:p.id,partyName:p.name,partyVersion:p.version,members:this.members(ctx,p),bosses:options.bosses??p.bosses.map(b=>({...b})),startAt:options.startAt,duration:options.duration??60,reminder:options.reminder??10,repeat:Boolean(options.repeat),note:short(options.note),status:options.mode==='poll'?'poll':'confirmed',version:1,revision:0,responses:{},votes:{},candidates:options.candidates??[],createdBy:ctx.userId,createdAt:this.now(),...options};
    requireRule(s.bosses.length,'파티에 보스를 먼저 등록해 주세요.');
    s.id=randomUUID();s.originalAt=s.startAt;s.endAt=(s.status==='poll'?Math.max(...s.candidates.map(c=>c.at)):s.startAt)+s.duration*60_000;
    if(s.status==='poll') {s.deadline=options.deadline??Math.min(this.now()+DAY,s.startAt-3600_000);requireRule(s.deadline>this.now()&&s.deadline<s.startAt,'후보가 너무 임박했어요. 출발 1시간 이상 남은 후보로 다시 입력하거나 바로 등록해 주세요.');this._job(s,'pollClosed',s.deadline);}
    return s;
  }
  lastDuration(ctx,partyId) {const row=this.db.prepare('SELECT data_json FROM schedules WHERE guild_id=? AND thread_id=? AND party_id=? ORDER BY rowid DESC LIMIT 1').get(ctx.guildId,ctx.threadId,partyId);return row?JSON.parse(row.data_json).duration:60;}
  parseInput(mode,raw,duration='') {
    const n=duration===''?60:Number(duration);requireRule(Number.isInteger(n)&&n>=15&&n<=240,'소요 시간은 15~240분으로 입력해 주세요.');
    const times=[...new Set(String(raw).split(/\r?\n/).filter(x=>x.trim()).map(x=>parseScheduleTime(x,this.now())))].sort((a,b)=>a-b);
    requireRule(mode==='poll'?times.length>=2&&times.length<=5:times.length===1,mode==='poll'?'서로 다른 후보를 2~5줄로 입력해 주세요.':'출발 시간 하나만 입력해 주세요.');
    return {mode,startAt:times[0],duration:n,candidates:times.map(at=>({id:randomUUID().slice(0,8),at}))};
  }
  draft(ctx,id) {
    const r=this.db.prepare('SELECT * FROM schedule_drafts WHERE id=? AND guild_id=? AND thread_id=? AND user_id=? AND expires_at>?').get(id,ctx.guildId,ctx.threadId,ctx.userId,this.now());
    requireRule(r,'입력 화면이 만료됐어요. 일정 잡기에서 다시 시작해 주세요.','STALE');return JSON.parse(r.data_json);
  }
  makeDraft(ctx,partyId,options,rid) {
    const p=this.party(ctx,partyId);requireEditable(ctx,p);
    this.members(ctx,p);requireRule(p.bosses.length,'파티에 보스를 먼저 등록해 주세요.');
    return this.transaction(ctx,rid,'draft',()=>{
      const draft={id:randomUUID(),partyId,partyVersion:p.version,bosses:p.bosses.map(b=>({...b})),repeat:false,reminder:10,...options};
      this.db.prepare('INSERT INTO schedule_drafts VALUES(?,?,?,?,?,?)').run(draft.id,ctx.guildId,ctx.threadId,ctx.userId,this.now()+30*60_000,JSON.stringify(draft));return draft;
    });
  }
  changeDraft(ctx,id,changes,rid) {
    return this.transaction(ctx,rid,'draft.change',()=>{const d=this.draft(ctx,id);requireEditable(ctx,this.party(ctx,d.partyId));Object.assign(d,changes);this.db.prepare('UPDATE schedule_drafts SET data_json=? WHERE id=?').run(JSON.stringify(d),id);return d;});
  }
  create(ctx,draftId,rid) {
    return this.transaction(ctx,rid,'create',()=>{
      const d=this.draft(ctx,draftId),p=this.party(ctx,d.partyId);requireEditable(ctx,p);
      requireRule(p.version===d.partyVersion,'파티 구성이 변경됐어요. 새 구성으로 일정을 다시 입력해 주세요.','STALE');
      requireRule(d.startAt>this.now(),'입력 중 출발 시간이 지났어요. 다시 입력해 주세요.');
      const s=this._new(ctx,p,d);s.partyVersion=p.version;
      const conflicts=s.status==='poll'?[]:this.conflicts(ctx,s);requireRule(!conflicts.length||short(d.reason),'겹치는 일정이 있어요. 확인 사유를 남긴 뒤 게시해 주세요.');s.conflictsAccepted=Boolean(conflicts.length&&short(d.reason));s.reason=short(d.reason);
      this._save(ctx,s);if(s.repeat&&s.status==='confirmed')this._startSeries(ctx,s);
      this._job(s,'publish',this.now(),{announce:true});this.db.prepare('DELETE FROM schedule_drafts WHERE id=?').run(draftId);
      return this.get(ctx,s.id);
    });
  }
  conflicts(ctx,s) {
    const rows=this.db.prepare("SELECT id FROM schedules WHERE guild_id=? AND thread_id=? AND id<>? AND status IN ('confirmed','review') AND start_at<? AND end_at>?").all(ctx.guildId,ctx.threadId,s.id??'',s.endAt??s.startAt+s.duration*60_000,s.startAt);
    return rows.map(r=>this.get(ctx,r.id)).map(other=>({id:other.id,partyName:other.partyName,startAt:other.startAt,users:ids(other).filter(id=>ids(s).includes(id))})).filter(c=>c.users.length);
  }
  _startSeries(ctx,s) {
    const p=this.party(ctx,s.partyId);
    const series={id:randomUUID(),partyId:s.partyId,version:1,active:true,nextAt:s.startAt+WEEK,nextOriginalAt:s.originalAt+WEEK,duration:s.duration,reminder:s.reminder,note:s.note,bosses:s.bosses,allBosses:s.bosses.length===p.bosses.length,consents:{}};
    this._series(ctx,series);s.seriesId=series.id;this._save(ctx,s);this._generate(ctx,series);
  }
  _generate(ctx,series) {
    if(!series.active)return;
    const p=this.partyService.getParty(ctx,series.partyId,true);if(p.archived||!p.characterIds.length||!p.bosses.length)return;
    // Do not replay months of missed occurrences after downtime.
    series.nextOriginalAt??=series.nextAt;
    while(series.nextAt<this.now()){series.nextAt+=WEEK;series.nextOriginalAt+=WEEK;}
    let count=0;
    while(series.nextAt<=this.now()+28*DAY&&count++<5) {
      const exists=this.db.prepare('SELECT id FROM schedules WHERE series_id=? AND original_at=?').get(series.id,series.nextOriginalAt);
      if(!exists) {
        const selected=series.allBosses?p.bosses:p.bosses.filter(b=>series.bosses.some(old=>old.bossId===b.bossId));
        const s=this._new(ctx,p,{startAt:series.nextAt,duration:series.duration,reminder:series.reminder,bosses:selected.length?selected:series.bosses,note:series.note,seriesId:series.id,repeat:true});
        s.originalAt=series.nextOriginalAt;
        for(const m of s.members) if(series.consents[m.userId]?.version===series.version)s.responses[m.userId]={state:series.consents[m.userId].characterId===m.characterId?'regular':'recheck',at:this.now()};
        if(!selected.length){s.status='review';s.compositionChanged=true;}
        if(this.conflicts(ctx,s).length)s.status='review';
        this._save(ctx,s);
      }
      series.nextAt+=WEEK;series.nextOriginalAt+=WEEK;
    }
    this._series(ctx,series);
  }
  _open(ctx,id,version=null) {
    const s=this.get(ctx,id);this.party(ctx,s.partyId);requireRule(!terminal(s)&&(s.status==='poll'?s.candidates.some(c=>c.at>this.now()):s.startAt>this.now()),'이미 시작했거나 취소된 일정이에요. 다음 일정에서 확인해 주세요.');
    if(version!=null)requireRule(s.version===Number(version),'일정 조건이 변경됐어요. 최신 화면을 열어 다시 확인해 주세요.','STALE');return s;
  }
  _member(ctx,s) {requireRule(ids(s).includes(ctx.userId),'이 회차의 파티원만 응답할 수 있어요.','FORBIDDEN');const p=this.party(ctx,s.partyId);requireRule(this.members(ctx,p).some(m=>m.userId===ctx.userId),'현재 파티원만 응답할 수 있어요.','FORBIDDEN');requireRule(p.characterIds.includes(s.members.find(m=>m.userId===ctx.userId).characterId),'파티 캐릭터가 변경됐어요. 관리자에게 현재 파티 구성 적용을 요청해 주세요.','STALE');}
  respond(ctx,id,state,version,rid) {
    return this.transaction(ctx,rid,'respond',()=>{const s=this._open(ctx,id,version);this._member(ctx,s);requireRule(s.status==='confirmed','시간 확정 후 참석 여부를 눌러 주세요.');requireRule(['yes','no','maybe'].includes(state),'응답을 다시 선택해 주세요.');
      const before=structuredClone(s),old=s.responses[ctx.userId]?.state;s.responses[ctx.userId]={state,at:this.now()};
      if(['yes','regular'].includes(old)&&state==='no')this._job(s,'dropout',this.now()+30_000,{userId:ctx.userId},ctx.userId);
      return this._save(ctx,s,before);
    });
  }
  vote(ctx,id,selected,version,rid) {
    return this.transaction(ctx,rid,'vote',()=>{const s=this._open(ctx,id,version);this._member(ctx,s);requireRule(s.status==='poll'&&s.deadline>this.now(),'투표가 마감됐어요. 파티장에게 문의해 주세요.');
      const allowed=s.candidates.map(c=>c.id);requireRule(Array.isArray(selected)&&selected.every(v=>allowed.includes(v)),'현재 후보에서 가능한 시간을 선택해 주세요.');
      const before=structuredClone(s);s.votes[ctx.userId]={values:[...new Set(selected)],known:allowed,at:this.now()};return this._save(ctx,s,before);
    });
  }
  tally(s) {
    return s.candidates.map(c=>{let yes=0,no=0,missing=0;for(const m of s.members){const v=s.votes[m.userId];if(!v?.known.includes(c.id))missing++;else if(v.values.includes(c.id))yes++;else no++;}return {...c,yes,no,missing};});
  }
  confirm(ctx,id,candidateId,version,reason,rid) {
    return this.transaction(ctx,rid,'confirm',()=>{const s=this._open(ctx,id,version);this.manager(ctx,s);requireRule(s.status==='poll'||s.status==='review','확정할 수 있는 일정이 아니에요.');const before=structuredClone(s);
      if(s.status==='poll') {
        const c=s.candidates.find(c=>c.id===candidateId);requireRule(c&&c.at>this.now(),'앞으로 출발할 후보를 선택해 주세요.');
        const t=this.tally(s).find(x=>x.id===candidateId);requireRule(t.yes===s.members.length||short(reason),'불가·미응답 인원이 있어요. 확인 사유를 입력해 주세요.');
        s.startAt=c.at;s.endAt=c.at+s.duration*60_000;s.responses={};for(const m of s.members){const v=s.votes[m.userId];if(v?.known.includes(c.id))s.responses[m.userId]={state:v.values.includes(c.id)?'yes':'no',at:this.now()};}
      }
      const collisions=this.conflicts(ctx,s);requireRule(!collisions.length||short(reason),'겹치는 일정이 있어요. 확인 사유를 입력해 주세요.');
      s.version++;s.status='confirmed';s.reason=short(reason);s.conflictsAccepted=Boolean(collisions.length);this._save(ctx,s,before);
      if(s.repeat&&!s.seriesId)this._startSeries(ctx,s);this._job(s,'confirmed',this.now());return this.get(ctx,id);
    });
  }
  regular(ctx,id,on,version,rid) {
    return this.transaction(ctx,rid,'regular',()=>{const s=this._open(ctx,id,version);this._member(ctx,s);requireRule(s.seriesId&&(!on||s.status==='confirmed'),'확정된 정기 일정에서만 설정할 수 있어요.');const series=this.series(ctx,s.seriesId);requireRule(series.active,'중단된 정기 일정이에요.');
      const previousConsent=series.consents[ctx.userId]??null;
      if(on){requireRule(!s.exception,'이번 회차만 변경된 시간이에요. 원래 시간의 회차에서 정기 참석에 동의해 주세요.');series.consents[ctx.userId]={version:series.version,characterId:s.members.find(m=>m.userId===ctx.userId).characterId,at:this.now()};}else delete series.consents[ctx.userId];this._series(ctx,series);
      this.db.prepare('INSERT INTO schedule_edits(schedule_id,user_id,at,before_json,after_json) VALUES(?,?,?,?,?)').run(s.id,ctx.userId,this.now(),JSON.stringify({regularConsent:previousConsent}),JSON.stringify({regularConsent:series.consents[ctx.userId]??null}));
      for(const row of this.db.prepare("SELECT id FROM schedules WHERE series_id=? AND start_at>? AND status IN ('confirmed','review')").all(series.id,this.now())) {
        const item=this.get(ctx,row.id);if(!ids(item).includes(ctx.userId)||item.exception)continue;
        const prior=item.responses[ctx.userId];if(on&&item.status==='confirmed'&&(!prior||['regular','recheck'].includes(prior.state)))item.responses[ctx.userId]={state:item.members.find(m=>m.userId===ctx.userId).characterId===series.consents[ctx.userId].characterId?'regular':'recheck',at:this.now()};
        if(!on&&prior?.state==='regular')delete item.responses[ctx.userId];this._save(ctx,item);
      }
      return this.get(ctx,id);
    });
  }
  edit(ctx,id,version,options,rid) {
    return this.transaction(ctx,rid,'edit',()=>{const s=this._open(ctx,id,version);this.manager(ctx,s);const before=structuredClone(s);const startAt=options.startAt??s.startAt,duration=options.duration??s.duration;
      requireRule(s.status!=='poll'||options.candidates,'투표 중에는 후보를 수정하거나 후보 하나를 확정한 뒤 시간을 변경해 주세요.');
      const changedTime=startAt!==s.startAt;requireRule(startAt>this.now(),'출발 시간은 앞으로의 시간으로 입력해 주세요.');
      if(options.candidates) {
        requireRule(options.candidates.length>=2&&options.candidates.length<=5,'후보를 2~5개 입력해 주세요.');
        s.candidates=options.candidates.map(c=>s.candidates.find(old=>old.at===c.at)??c);s.status='poll';s.pollClosed=false;s.deadline=Math.min(this.now()+DAY,s.candidates[0].at-3600_000);requireRule(s.deadline>this.now(),'투표 후보는 1시간 이상 뒤로 입력해 주세요.');
      }
      s.startAt=startAt;s.duration=duration;s.endAt=(options.candidates?Math.max(...s.candidates.map(c=>c.at)):startAt)+duration*60_000;s.note=options.note!=null?short(options.note):s.note;
      const conditionsChanged=changedTime||Boolean(options.candidates);
      if(conditionsChanged){s.version++;s.exception=!options.future;s.previousResponses=s.responses;s.responses=Object.fromEntries(Object.keys(s.responses).map(u=>[u,{state:'recheck',at:this.now()}]));}
      if(conditionsChanged||duration>before.duration)s.conflictsAccepted=false;
      const conflicts=this.conflicts(ctx,s);if(!conflicts.length)s.conflictsAccepted=false;if(conflicts.length&&!s.conflictsAccepted)s.status=s.status==='poll'?'poll':'review';
      if(duration>before.duration&&!changedTime)for(const c of conflicts)for(const user of c.users)s.responses[user]={state:'recheck',at:this.now()};
      this._save(ctx,s,before);if(s.status==='poll')this._job(s,'pollClosed',s.deadline);
      if(options.future&&s.seriesId) {
        const series=this.series(ctx,s.seriesId);series.duration=duration;series.note=s.note;
        if(changedTime){series.version++;series.nextAt=startAt+WEEK;series.nextOriginalAt=s.originalAt+WEEK;series.consents={};}
        this._series(ctx,series);
        for(const r of this.db.prepare("SELECT id FROM schedules WHERE series_id=? AND id<>? AND original_at>=? AND start_at>? AND status NOT IN ('cancelled','elapsed')").all(series.id,id,s.originalAt,this.now())) {
          const old=this.get(ctx,r.id),prior=structuredClone(old);
          if(changedTime){old.startAt=startAt+(old.originalAt-s.originalAt);old.duration=duration;old.endAt=old.startAt+duration*60_000;old.version++;old.exception=false;old.conflictsAccepted=false;old.status='confirmed';old.previousResponses=old.responses;old.responses=Object.fromEntries(Object.keys(old.responses).map(u=>[u,{state:'recheck',at:this.now()}]));if(this.conflicts(ctx,old).length)old.status='review';}
          else {old.duration=duration;old.endAt=old.startAt+duration*60_000;old.note=s.note;const collisions=this.conflicts(ctx,old);if(collisions.length){old.status='review';for(const c of collisions)for(const u of c.users)old.responses[u]={state:'recheck',at:this.now()};}}
          this._save(ctx,old,prior);if(old.messageId)this._job(old,'changed',this.now(),{beforeStartAt:prior.startAt},rid);
        }
        this._generate(ctx,series);
      }
      this._job(s,'changed',this.now(),{beforeStartAt:before.startAt,previousUsers:ids(before)},rid);return this.get(ctx,id);
    });
  }
  cancel(ctx,id,version,future,rid) {
    return this.transaction(ctx,rid,'cancel',()=>{const s=this._open(ctx,id,version);this.manager(ctx,s);const before=structuredClone(s);
      let targets=[s];if(future&&s.seriesId){const series=this.series(ctx,s.seriesId);series.active=false;this._series(ctx,series);targets=this.db.prepare("SELECT id FROM schedules WHERE series_id=? AND original_at>=? AND start_at>? AND status NOT IN ('cancelled','elapsed')").all(s.seriesId,s.originalAt,this.now()).map(r=>this.get(ctx,r.id));}
      for(const item of targets){item.status='cancelled';item.version++;this._save(ctx,item,item.id===s.id?before:null);if(item.id===s.id||item.messageId)this._job(item,'cancelled',this.now());}return this.get(ctx,id);
    });
  }
  upcomingCount(ctx,id) {const s=this.get(ctx,id);return s.seriesId?this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE series_id=? AND original_at>=? AND start_at>? AND status NOT IN ('cancelled','elapsed')").get(s.seriesId,s.originalAt,this.now()).n:1;}
  applyParty(ctx,id,version,rid) {
    return this.transaction(ctx,rid,'composition',()=>{const s=this._open(ctx,id,version);this.manager(ctx,s);const before=structuredClone(s),p=this.party(ctx,s.partyId),members=this.members(ctx,p),newIds=new Set(members.map(m=>m.userId));
      const consent=s.seriesId?this.series(ctx,s.seriesId):null;if(consent){for(const u of Object.keys(consent.consents))if(!newIds.has(u)||members.find(m=>m.userId===u)?.characterId!==consent.consents[u].characterId)delete consent.consents[u];this._series(ctx,consent);}
      const recheck=p.bosses.some(b=>!s.bosses.some(x=>same(x,b)));
      for(const m of members){const old=s.members.find(x=>x.userId===m.userId);if(old&&(old.characterId!==m.characterId||recheck)){s.responses[m.userId]={state:'recheck',at:this.now()};delete s.votes[m.userId];}}
      s.previousMembers=s.members;s.members=members;s.bosses=p.bosses.map(b=>({...b}));s.responses=Object.fromEntries(Object.entries(s.responses).filter(([u])=>newIds.has(u)));s.votes=Object.fromEntries(Object.entries(s.votes).filter(([u])=>newIds.has(u)));s.partyVersion=p.version;s.partyName=p.name;s.version++;s.compositionChanged=false;
      this._save(ctx,s,before);this._job(s,'changed',this.now(),{beforeStartAt:before.startAt,previousUsers:ids(before)},rid);return this.get(ctx,id);
    });
  }
  nudge(ctx,id,rid) {
    return this.transaction(ctx,rid,'nudge',()=>{const s=this._open(ctx,id);this.manager(ctx,s);requireRule(s.status!=='poll'||s.deadline>this.now(),'마감된 투표에는 미응답 알림을 보낼 수 없어요.');const log=s.nudges??[];requireRule(log.length<2&&(!log.length||this.now()-log.at(-1)>=3600_000),'미응답 알림은 1시간 간격, 회차당 2회까지 보낼 수 있어요.');s.nudges=[...log,this.now()];this._save(ctx,s);this._job(s,'nudge',this.now(),{},rid);return s;});
  }
  repost(ctx,id,rid) {return this.transaction(ctx,rid,'repost',()=>{const s=this.get(ctx,id);this.manager(ctx,s);this._job(s,'publish',this.now(),{announce:false,manual:true},rid);return s;});}
  deliveryIssues(ctx,id) {
    const s=this.get(ctx,id);
    return this.db.prepare("SELECT kind,error FROM schedule_jobs WHERE schedule_id=? AND version=? AND state IN ('failed','unknown') ORDER BY rowid DESC LIMIT 3").all(id,s.version);
  }
  retryDelivery(ctx,id,version,rid) {
    return this.transaction(ctx,rid,'retry',()=>{
      const s=this.get(ctx,id);this.manager(ctx,s);requireRule(s.version===Number(version),'일정이 변경됐어요. 최신 화면에서 다시 시도해 주세요.','STALE');
      for(const job of this.db.prepare("SELECT * FROM schedule_jobs WHERE schedule_id=? AND version=? AND state IN ('failed','unknown')").all(id,s.version)) {
        if(job.kind==='reminder'&&s.startAt<=this.now())continue;
        this._job(s,job.kind,this.now(),{...JSON.parse(job.data_json),manual:true},rid);
        this.db.prepare("UPDATE schedule_jobs SET state='retried' WHERE id=?").run(job.id);
      }
      return s;
    });
  }
  markMessage(ctx,id,messageId,revision) {this.db.prepare('UPDATE schedules SET message_id=?,rendered=? WHERE id=? AND guild_id=? AND thread_id=?').run(messageId,revision,id,ctx.guildId,ctx.threadId);}
  scopes() {return this.db.prepare('SELECT DISTINCT guild_id,thread_id FROM schedules UNION SELECT guild_id,thread_id FROM schedule_series').all().map(r=>({guildId:r.guild_id,threadId:r.thread_id,userId:'system'}));}
  maintenance(ctx) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM schedule_drafts WHERE expires_at<=?').run(this.now());
      const state=this.partyService.snapshot(ctx);
      for(const row of this.db.prepare('SELECT data_json FROM schedule_series WHERE guild_id=? AND thread_id=?').all(ctx.guildId,ctx.threadId)) {const series=JSON.parse(row.data_json),p=state.parties.find(p=>p.id===series.partyId);if(!p||p.archived){series.active=false;this._series(ctx,series);}else {const currentOwners=new Set(p.characterIds.map(id=>state.characters.find(c=>c.id===id)?.ownerId));for(const u of Object.keys(series.consents))if(!currentOwners.has(u))delete series.consents[u];this._generate(ctx,series);}}
      const all=this.db.prepare('SELECT id FROM schedules WHERE guild_id=? AND thread_id=?').all(ctx.guildId,ctx.threadId).map(r=>this.get(ctx,r.id));
      for(const s of all) {
        if(terminal(s))continue;
        const p=state.parties.find(p=>p.id===s.partyId);
        if(!p||p.archived){s.status='cancelled';s.version++;this._save(ctx,s);if(s.messageId)this._job(s,'cancelled',this.now());continue;}
        if(s.status==='poll'&&s.deadline<=this.now()&&!s.pollClosed){s.pollClosed=true;this._save(ctx,s);}
        if(s.status!=='poll'&&s.startAt<=this.now()&&!s.timePassed){s.timePassed=true;this._save(ctx,s);}
        const changed=p.version!==s.partyVersion||s.bosses.some(b=>!p.bosses.some(x=>same(x,b)));
        if(changed!==Boolean(s.compositionChanged)){s.compositionChanged=changed;this._save(ctx,s);}
        if(s.endAt<=this.now()){s.status='elapsed';this._save(ctx,s);continue;}
        const eligiblePublish=!s.seriesId||!all.some(other=>other.seriesId===s.seriesId&&!terminal(other)&&other.endAt>this.now()&&other.startAt<s.startAt);
        if(!s.messageId&&eligiblePublish)this._job(s,'publish',this.now());
        if(s.status==='review'&&eligiblePublish)this._job(s,'conflict',this.now());
      }
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}
