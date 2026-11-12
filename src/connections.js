import { createCipheriv,createDecipheriv,createHmac,randomBytes,randomUUID } from 'node:crypto';
import { requireRule,DomainError } from './errors.js';
import { NexonClient,kstDay } from './nexon.js';

const scope=ctx=>`${ctx.guildId}:${ctx.threadId}:${ctx.userId}`;
const args=ctx=>[ctx.guildId,ctx.threadId,ctx.userId];
export class KeyVault {
  constructor(secret='') {
    this.key=Buffer.from(secret,'base64');
    this.configured=/^[A-Za-z0-9+/]{43}=$/.test(secret)&&this.key.length===32;
  }
  requireConfigured() {requireRule(this.configured,'서버에 API_KEY_ENCRYPTION_KEY 설정이 필요해요. 운영자에게 알려 주세요.','KEY_CONFIG');}
  seal(value,context) {
    this.requireConfigured();const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(context));
    return JSON.stringify({iv:iv.toString('base64'),data:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')});
  }
  open(value,context) {
    this.requireConfigured();
    try {
      const sealed=JSON.parse(value),decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(sealed.iv,'base64'));
      decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString('utf8');
    } catch {throw new DomainError('저장된 API 연결을 열지 못했어요. 서버 암호화 키를 확인해 주세요.','KEY_DECRYPT');}
  }
  fingerprint(value) {this.requireConfigured();return createHmac('sha256',this.key).update(value).digest('hex');}
}

export class PersonalConnections {
  constructor({repository,service,encryptionKey='',now=()=>Date.now(),clientFactory=options=>new NexonClient(options)}) {
    this.repo=repository;this.service=service;this.now=now;this.vault=new KeyVault(encryptionKey);this.factory=clientFactory;this.clients=new Map();this.pending=new Map();this.gates=new Map();this.stopped=false;
    repository.db.exec(`CREATE TABLE IF NOT EXISTS personal_connections (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,
      sealed_key TEXT NOT NULL,fingerprint TEXT NOT NULL,version TEXT NOT NULL,imported_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,user_id));
      CREATE TABLE IF NOT EXISTS personal_characters (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,character_id TEXT NOT NULL,user_id TEXT NOT NULL,
      identity_hash TEXT NOT NULL,sealed_ocid TEXT NOT NULL,available INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,character_id));
      CREATE TABLE IF NOT EXISTS personal_api_budget (
      fingerprint TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(fingerprint,day));`);
  }
  row(ctx) {return this.repo.db.prepare('SELECT * FROM personal_connections WHERE guild_id=? AND thread_id=? AND user_id=?').get(...args(ctx));}
  status(ctx) {
    const row=this.row(ctx);
    return {configured:this.vault.configured,connected:Boolean(row),importedAt:row?.imported_at??null,count:this.repo.db.prepare('SELECT count(*) AS n FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=? AND available=1').get(...args(ctx)).n};
  }
  reserve(fingerprint) {
    return this.repo.db.prepare(`INSERT INTO personal_api_budget VALUES(?,?,1) ON CONFLICT(fingerprint,day) DO UPDATE SET calls=calls+1 WHERE calls<900`).run(fingerprint,kstDay(this.now())).changes>0;
  }
  client(key,fingerprint,isActive=()=>true) {
    let gate=this.gates.get(fingerprint);
    if(!gate) {gate={tail:Promise.resolve()};this.gates.set(fingerprint,gate);}
    return this.factory({apiKey:key,reserve:()=>this.reserve(fingerprint),isActive:()=>!this.stopped&&isActive(),gate});
  }
  assertCurrent(ctx,version) {requireRule(!this.stopped&&this.row(ctx)?.version===version,'API 연결이 변경되었어요. 다시 시도해 주세요.','KEY_CHANGED');}
  async connect(ctx,key) {
    this.service.snapshot(ctx);this.vault.requireConfigured();
    requireRule(!this.stopped,'봇이 종료 중이에요.');
    requireRule(typeof key==='string'&&key.trim().length>=20&&key.trim().length<=512&&!/\s/.test(key.trim()),'메이플스토리용 개인 API 키를 다시 확인해 주세요.','KEY_INPUT');
    this.pending.get(scope(ctx))?.close?.();
    key=key.trim();const before=this.row(ctx)?.version??null,fingerprint=this.vault.fingerprint(key),api=this.client(key,fingerprint);
    this.pending.set(scope(ctx),api);
    try {
      const characters=await api.listCharacters();
      requireRule(!this.stopped&&this.pending.get(scope(ctx))===api&&(this.row(ctx)?.version??null)===before,'다른 연결 요청이 먼저 처리됐어요. 다시 확인해 주세요.','KEY_CHANGED');
      const version=randomUUID();
      const db=this.repo.db;db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO personal_connections VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild_id,thread_id,user_id) DO UPDATE SET sealed_key=excluded.sealed_key,fingerprint=excluded.fingerprint,version=excluded.version,imported_at=excluded.imported_at').run(...args(ctx),this.vault.seal(key,scope(ctx)),fingerprint,version,this.now());
        const result=this.importCharacters(ctx,characters);db.exec('COMMIT');
        this.evict(ctx);return result;
      } catch(error) {db.exec('ROLLBACK');throw error;}
    } finally {api.close?.();if(this.pending.get(scope(ctx))===api)this.pending.delete(scope(ctx));}
  }
  importCharacters(ctx,characters) {
    const db=this.repo.db,state=this.service.snapshot(ctx);let added=0,updated=0,conflicts=0;
    db.prepare('UPDATE personal_characters SET available=0 WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));
    for(const remote of characters) {
      const hash=this.vault.fingerprint(remote.ocid);
      const binding=db.prepare('SELECT character_id FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=? AND identity_hash=?').get(...args(ctx),hash);
      let local=binding&&state.characters.find(c=>c.id===binding.character_id);
      if(!local) local=state.characters.find(c=>c.active&&c.ownerId===ctx.userId&&c.name.toLocaleLowerCase()===remote.name.toLocaleLowerCase()&&(!c.world||c.world===remote.world));
      const conflict=state.characters.some(c=>c.active&&c.id!==local?.id&&c.name.toLocaleLowerCase()===remote.name.toLocaleLowerCase()&&(!c.world||c.world===remote.world));
      if(conflict) {conflicts++;continue;}
      if(!local) {local={id:randomUUID(),ownerId:ctx.userId,active:true};state.characters.push(local);added++;} else updated++;
      Object.assign(local,{name:remote.name,world:remote.world,job:remote.job,apiLinked:true});
      db.prepare('INSERT INTO personal_characters VALUES(?,?,?,?,?,?,1) ON CONFLICT(guild_id,thread_id,character_id) DO UPDATE SET identity_hash=excluded.identity_hash,sealed_ocid=excluded.sealed_ocid,available=1').run(ctx.guildId,ctx.threadId,local.id,ctx.userId,hash,this.vault.seal(remote.ocid,`${scope(ctx)}:${local.id}`));
    }
    db.prepare('UPDATE workspaces SET state_json=?,revision=revision+1 WHERE guild_id=? AND thread_id=?').run(JSON.stringify(state),ctx.guildId,ctx.threadId);
    db.prepare('UPDATE personal_connections SET imported_at=? WHERE guild_id=? AND thread_id=? AND user_id=?').run(this.now(),...args(ctx));
    return {added,updated,conflicts,total:characters.length};
  }
  connectionSession(ctx) {
    const row=this.row(ctx);requireRule(row,'먼저 내 API 키를 연결해 주세요.','KEY_MISSING');
    const cacheKey=`${scope(ctx)}:${row.version}`;let api=this.clients.get(cacheKey);
    if(!api) {api=this.client(this.vault.open(row.sealed_key,scope(ctx)),row.fingerprint,()=>this.row(ctx)?.version===row.version);this.clients.set(cacheKey,api);}
    return {api,version:row.version,assertCurrent:()=>this.assertCurrent(ctx,row.version)};
  }
  session(ctx,character) {
    const owner={...ctx,userId:character.ownerId},connection=this.connectionSession(owner);
    const binding=this.repo.db.prepare('SELECT sealed_ocid,identity_hash FROM personal_characters WHERE guild_id=? AND thread_id=? AND character_id=? AND user_id=? AND available=1').get(ctx.guildId,ctx.threadId,character.id,character.ownerId);
    requireRule(binding,'연결한 계정의 캐릭터 목록을 동기화해 주세요.','KEY_CHARACTER');
    return {...connection,ocid:this.vault.open(binding.sealed_ocid,`${scope(owner)}:${character.id}`),assertCurrent:()=>{
      connection.assertCurrent();
      const current=this.repo.db.prepare('SELECT identity_hash FROM personal_characters WHERE guild_id=? AND thread_id=? AND character_id=? AND user_id=? AND available=1').get(ctx.guildId,ctx.threadId,character.id,character.ownerId);
      requireRule(current?.identity_hash===binding.identity_hash,'계정 캐릭터 목록이 변경되었어요. 다시 동기화해 주세요.','KEY_CHARACTER');
    }};
  }
  async refresh(ctx,{automatic=false}={}) {
    const row=this.row(ctx);requireRule(row,'먼저 내 API 키를 연결해 주세요.','KEY_MISSING');
    if(this.now()-row.imported_at<(automatic?6*3600_000:60_000)) return {cached:true};
    const session=this.connectionSession(ctx),characters=await session.api.listCharacters();session.assertCurrent();
    const db=this.repo.db;db.exec('BEGIN IMMEDIATE');
    try {const result=this.importCharacters(ctx,characters);db.exec('COMMIT');return result;} catch(error) {db.exec('ROLLBACK');throw error;}
  }
  evict(ctx) {for(const [key,api] of this.clients) if(key.startsWith(`${scope(ctx)}:`)) {api.close?.();this.clients.delete(key);}}
  disconnect(ctx,version) {
    if(version!==undefined)this.assertCurrent(ctx,version);
    this.pending.get(scope(ctx))?.close?.();this.pending.delete(scope(ctx));
    this.evict(ctx);const db=this.repo.db;db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));
      db.prepare('DELETE FROM personal_connections WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  async sweep({guildId,canCollect,onUpdate=async()=>{}}) {
    this.repo.db.prepare('DELETE FROM personal_api_budget WHERE day<?').run(kstDay(this.now()-2*86400_000));
    for(const row of this.repo.db.prepare('SELECT guild_id,thread_id,user_id FROM personal_connections WHERE guild_id=?').all(guildId)) {
      if(this.stopped) return;
      const ctx={guildId:row.guild_id,threadId:row.thread_id,userId:row.user_id};
      try {if(await canCollect(ctx)) {const result=await this.refresh(ctx,{automatic:true});if(!result.cached&&!this.stopped)await onUpdate(ctx);}} catch(error) {console.warn('[account-sync]',error.code??'FAILED');}
    }
  }
  close() {this.stopped=true;for(const api of this.pending.values())api.close?.();this.pending.clear();for(const api of this.clients.values())api.close?.();this.clients.clear();}
}
