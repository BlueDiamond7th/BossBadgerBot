import { randomUUID } from 'node:crypto';
import { requireRule } from './errors.js';
import { kstDay } from './nexon.js';

const RETENTION_MS=29*86400_000;
const stable=value=>JSON.stringify(value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):value??null);
export function specChanges(previous,current) {
  if(!previous) return ['첫 기록이에요. 다음 수집부터 변화를 비교해요.'];
  const lines=[];
  for(const [key,label] of [['level','레벨'],['combatPower','전투력']]) if(previous[key]!==current[key]) {
    const diff=BigInt(current[key])-BigInt(previous[key]);
    lines.push(`${label}: ${previous[key]} → ${current[key]} (${diff>=0n?'+':''}${diff})`);
  }
  if(previous.preset!==current.preset) lines.push(`장비 프리셋: ${previous.preset??'미확인'} → ${current.preset??'미확인'} (세팅 전환일 수 있어요)`);
  for(const slot of new Set([...Object.keys(previous.equipment),...Object.keys(current.equipment)])) {
    const before=previous.equipment[slot],after=current.equipment[slot];
    if(stable(before)===stable(after)) continue;
    if(!before||!after||before.item_name!==after.item_name) lines.push(`${slot}: ${before?.item_name??'미착용'} → ${after?.item_name??'미착용'}`);
    if(before&&after) for(const key of new Set([...Object.keys(before),...Object.keys(after)])) {
      if(key==='item_name'||stable(before[key])===stable(after[key])) continue;
      const labels={starforce:'스타포스',potential_option_grade:'잠재 등급',additional_potential_option_grade:'에디셔널 등급',potential_option_1:'잠재 1',potential_option_2:'잠재 2',potential_option_3:'잠재 3',additional_potential_option_1:'에디 1',additional_potential_option_2:'에디 2',additional_potential_option_3:'에디 3',item_total_option:'최종 옵션',item_add_option:'추가 옵션'};
      const label=labels[key]??key;
      if(typeof before[key]==='object'||typeof after[key]==='object') {
        for(const field of new Set([...Object.keys(before[key]??{}),...Object.keys(after[key]??{})])) if(stable(before[key]?.[field])!==stable(after[key]?.[field])) lines.push(`${slot} ${label} ${field}: ${before[key]?.[field]??'-'} → ${after[key]?.[field]??'-'}`);
      } else lines.push(`${slot} ${label}: ${before[key]??'-'} → ${after[key]??'-'}`);
    }
  }
  for(const grade of new Set([...Object.keys(previous.skills),...Object.keys(current.skills)])) {
    // Missing sections mean unavailable data, never zero levels or removed skills.
    if(previous.unavailable?.includes(grade)||current.unavailable?.includes(grade)||!current.skills[grade]) continue;
    for(const name of new Set([...Object.keys(previous.skills[grade]??{}),...Object.keys(current.skills[grade])])) {
      const before=previous.skills[grade]?.[name],after=current.skills[grade][name];
      if(before!==after) lines.push(`${grade}차 ${name}: ${before??'미등록'} → ${after??'미등록'}`);
    }
  }
  return lines.length?lines:['비교 가능한 항목의 변화가 없어요.'];
}

export class SpecTracker {
  constructor({repository,service,api,now=()=>Date.now()}) {
    this.repo=repository;this.service=service;this.api=api;this.now=now;this.inflight=new Map();this.stopped=false;
    repository.db.exec(`CREATE TABLE IF NOT EXISTS spec_profiles (
      guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, character_id TEXT NOT NULL, ocid TEXT NOT NULL,
      PRIMARY KEY(guild_id,thread_id,character_id));
      CREATE TABLE IF NOT EXISTS spec_snapshots (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, character_id TEXT NOT NULL,
      collected_at INTEGER NOT NULL, day TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS spec_history ON spec_snapshots(guild_id,thread_id,character_id,collected_at);
      CREATE TABLE IF NOT EXISTS spec_manual (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, character_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL, value REAL NOT NULL, metric TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nexon_budget(day TEXT PRIMARY KEY, calls INTEGER NOT NULL);`);
  }
  reserve(limit=900) {
    const day=kstDay(this.now());
    return this.repo.db.prepare(`INSERT INTO nexon_budget(day,calls) VALUES(?,1)
      ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<?`).run(day,limit).changes>0;
  }
  character(ctx,id,owner=false) {
    const c=this.service.snapshot(ctx).characters.find(c=>c.id===id&&c.active);
    requireRule(c,'현재 등록된 캐릭터를 선택해 주세요.','NOT_FOUND');
    if(owner) requireRule(c.ownerId===ctx.userId,'본인이 등록한 캐릭터만 갱신하거나 환산을 기록할 수 있어요.','FORBIDDEN');
    return c;
  }
  history(ctx,id) {
    this.character(ctx,id);this.prune();
    return this.repo.db.prepare('SELECT * FROM spec_snapshots WHERE guild_id=? AND thread_id=? AND character_id=? ORDER BY collected_at DESC,rowid DESC LIMIT 100').all(ctx.guildId,ctx.threadId,id).map(row=>({...JSON.parse(row.data_json),id:row.id,collectedAt:row.collected_at,day:row.day}));
  }
  manualHistory(ctx,id) {
    this.character(ctx,id);
    return this.repo.db.prepare('SELECT value,metric,recorded_at FROM spec_manual WHERE guild_id=? AND thread_id=? AND character_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 30').all(ctx.guildId,ctx.threadId,id);
  }
  recordManual(ctx,id,value,metric,rid) {
    this.character(ctx,id,true);
    requireRule(Number.isFinite(value)&&value>0&&value<=1e9,'환산 수치를 양수로 입력해 주세요. 만 단위가 아닌 표시된 숫자를 그대로 입력해 주세요.');
    requireRule(['주스탯','헥사'].includes(metric),'환산 종류를 선택해 주세요.');
    this.repo.db.prepare('INSERT OR IGNORE INTO spec_manual VALUES(?,?,?,?,?,?,?)').run(rid,ctx.guildId,ctx.threadId,id,this.now(),value,metric);
  }
  async sync(ctx,id,{automatic=false}={}) {
    const c=this.character(ctx,id,!automatic),key=`${ctx.guildId}:${ctx.threadId}:${id}`;
    requireRule(!this.stopped,'봇이 종료 중이에요. 잠시 후 다시 시도해 주세요.');
    if(this.inflight.has(key)) return this.inflight.get(key);
    const history=this.history(ctx,id),latest=history[0];
    if(latest&&(automatic?latest.day===kstDay(this.now()):this.now()-latest.collectedAt<10*60_000)) return {cached:true};
    const work=(async()=>{
      const profile=this.repo.db.prepare('SELECT ocid FROM spec_profiles WHERE guild_id=? AND thread_id=? AND character_id=?').get(ctx.guildId,ctx.threadId,id);
      const result=await this.api.collect(c.name,profile?.ocid);
      if(this.stopped) return {stopped:true};
      // The character may have been renamed or unregistered while requests were pending.
      const current=this.character(ctx,id,!automatic);
      requireRule(current.name===c.name,'수집 중 캐릭터 이름이 변경됐어요. 다시 갱신해 주세요.','STALE');
      const now=this.now(),snapshotId=randomUUID();
      const db=this.repo.db;db.exec('BEGIN IMMEDIATE');
      try {
        const state=this.service.snapshot(ctx),target=state.characters.find(x=>x.id===id);
        requireRule(!state.characters.some(x=>x.active&&x.id!==id&&x.name.toLocaleLowerCase()===result.profile.name.toLocaleLowerCase()&&(!x.world||x.world===result.profile.world)),'API 정보와 중복되는 등록 캐릭터가 있어요. 기존 등록을 확인해 주세요.','DUPLICATE');
        Object.assign(target,result.profile,{apiLinked:true});
        db.prepare('UPDATE workspaces SET state_json=?,revision=revision+1 WHERE guild_id=? AND thread_id=?').run(JSON.stringify(state),ctx.guildId,ctx.threadId);
        db.prepare('INSERT INTO spec_profiles VALUES(?,?,?,?) ON CONFLICT(guild_id,thread_id,character_id) DO UPDATE SET ocid=excluded.ocid').run(ctx.guildId,ctx.threadId,id,result.ocid);
        db.prepare('INSERT INTO spec_snapshots VALUES(?,?,?,?,?,?,?)').run(snapshotId,ctx.guildId,ctx.threadId,id,now,kstDay(now),JSON.stringify(result.data));
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return {cached:false};
    })();
    this.inflight.set(key,work);
    try {return await work;} finally {this.inflight.delete(key);}
  }
  prune() {
    this.repo.db.prepare('DELETE FROM spec_snapshots WHERE collected_at<?').run(this.now()-RETENTION_MS);
    this.repo.db.prepare('DELETE FROM nexon_budget WHERE day<?').run(kstDay(this.now()-2*86400_000));
  }
  async sweep({guildId,canCollect=async()=>true,onUpdate=async()=>{}}) {
    this.prune();
    const rows=this.repo.db.prepare('SELECT guild_id,thread_id,state_json FROM workspaces WHERE guild_id=?').all(guildId);
    for(const row of rows) for(const c of JSON.parse(row.state_json).characters.filter(c=>c.active)) {
      if(this.stopped) return;
      const ctx={guildId:row.guild_id,threadId:row.thread_id,userId:c.ownerId};
      try {
        if(this.history(ctx,c.id)[0]?.day===kstDay(this.now())) continue;
        if(!await canCollect(ctx)) continue;
        await this.sync(ctx,c.id,{automatic:true});
        if(this.stopped) return;
        await onUpdate(ctx);
      } catch(error) {
        console.warn('[spec-sync]',error.code??'FAILED');
        if(['NEXON_BUDGET','NEXON_CONFIG','OPENAPI00005','OPENAPI00007'].includes(error.code)) return;
      }
    }
  }
  async stop() {this.stopped=true;this.api.close?.();await Promise.allSettled([...this.inflight.values()]);}
}
