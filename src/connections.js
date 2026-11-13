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
    this.repo=repository;this.service=service;this.now=now;this.vault=new KeyVault(encryptionKey);this.factory=clientFactory;this.clients=new Map();this.pending=new Map();this.gates=new Map();this.stopped=false;this.selections=new Map();this.powerInflight=new Map();
    repository.db.exec(`CREATE TABLE IF NOT EXISTS personal_connections (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,
      sealed_key TEXT NOT NULL,fingerprint TEXT NOT NULL,version TEXT NOT NULL,imported_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,user_id));
      CREATE TABLE IF NOT EXISTS personal_characters (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,character_id TEXT NOT NULL,user_id TEXT NOT NULL,
      identity_hash TEXT NOT NULL,sealed_ocid TEXT NOT NULL,available INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,character_id));
      CREATE TABLE IF NOT EXISTS personal_candidates (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,sealed_list TEXT NOT NULL,
      PRIMARY KEY(guild_id,thread_id,user_id));
      CREATE TABLE IF NOT EXISTS personal_selection_power (
      guild_id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,identity_hash TEXT NOT NULL,
      combat_power TEXT NOT NULL,collected_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,user_id,identity_hash));
      CREATE TABLE IF NOT EXISTS personal_api_budget (
      fingerprint TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(fingerprint,day));`);
  }
  row(ctx) {return this.repo.db.prepare('SELECT * FROM personal_connections WHERE guild_id=? AND thread_id=? AND user_id=?').get(...args(ctx));}
  status(ctx) {
    const row=this.row(ctx);
    return {configured:this.vault.configured,connected:Boolean(row),importedAt:row?.imported_at??null,count:JSON.parse(this.repo.db.prepare('SELECT state_json FROM workspaces WHERE guild_id=? AND thread_id=?').get(ctx.guildId,ctx.threadId)?.state_json??'{"characters":[]}').characters.filter(c=>c.active&&c.ownerId===ctx.userId).length};
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
  importCharacters(ctx,characters,{selected=null}={}) {
    const db=this.repo.db,state=this.service.snapshot(ctx);let added=0,updated=0,conflicts=0;
    db.prepare('INSERT INTO personal_candidates VALUES(?,?,?,?) ON CONFLICT(guild_id,thread_id,user_id) DO UPDATE SET sealed_list=excluded.sealed_list').run(...args(ctx),this.vault.seal(JSON.stringify(characters),`${scope(ctx)}:candidates`));
    db.prepare('UPDATE personal_characters SET available=0 WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));
    for(const remote of characters) {
      const hash=this.vault.fingerprint(remote.ocid);
      const binding=db.prepare('SELECT character_id FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=? AND identity_hash=?').get(...args(ctx),hash);
      let local=binding&&state.characters.find(c=>c.id===binding.character_id);
      const chosen=selected?.has(hash)??false;
      if(!chosen&&(!local||!local.active))continue;
      if(!local) local=state.characters.find(c=>c.ownerId===ctx.userId&&c.name.toLocaleLowerCase()===remote.name.toLocaleLowerCase()&&(!c.world||c.world===remote.world));
      const conflict=state.characters.some(c=>c.active&&c.id!==local?.id&&c.name.toLocaleLowerCase()===remote.name.toLocaleLowerCase()&&(!c.world||c.world===remote.world));
      if(conflict) {conflicts++;continue;}
      if(!local) {local={id:randomUUID(),ownerId:ctx.userId,active:true};state.characters.push(local);added++;} else updated++;
      Object.assign(local,{name:remote.name,world:remote.world,job:remote.job,apiLinked:true,...(chosen?{active:true}:{})});
      db.prepare('INSERT INTO personal_characters VALUES(?,?,?,?,?,?,1) ON CONFLICT(guild_id,thread_id,character_id) DO UPDATE SET identity_hash=excluded.identity_hash,sealed_ocid=excluded.sealed_ocid,available=1').run(ctx.guildId,ctx.threadId,local.id,ctx.userId,hash,this.vault.seal(remote.ocid,`${scope(ctx)}:${local.id}`));
    }
    db.prepare('UPDATE workspaces SET state_json=?,revision=revision+1 WHERE guild_id=? AND thread_id=?').run(JSON.stringify(state),ctx.guildId,ctx.threadId);
    db.prepare('UPDATE personal_connections SET imported_at=? WHERE guild_id=? AND thread_id=? AND user_id=?').run(this.now(),...args(ctx));
    return {added,updated,conflicts,total:characters.length};
  }
  candidates(ctx) {
    const row=this.repo.db.prepare('SELECT sealed_list FROM personal_candidates WHERE guild_id=? AND thread_id=? AND user_id=?').get(...args(ctx));
    return row?JSON.parse(this.vault.open(row.sealed_list,`${scope(ctx)}:candidates`)):[];
  }
  beginSelection(ctx,mode='add') {
    requireRule(['add','remove'].includes(mode),'지원하지 않는 캐릭터 관리 동작이에요.');
    const version=this.row(ctx)?.version??null,state=this.service.snapshot(ctx);
    if(mode==='add')requireRule(version,'먼저 내 API 키를 연결해 주세요.','KEY_MISSING');
    const own=state.characters.filter(c=>c.ownerId===ctx.userId&&c.active);
    const bindings=this.repo.db.prepare('SELECT character_id,identity_hash FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=?').all(...args(ctx));
    const bound=new Set(bindings.filter(b=>own.some(c=>c.id===b.character_id)).map(b=>b.identity_hash));
    const candidates=this.candidates(ctx),byHash=new Map(candidates.map(c=>[this.vault.fingerprint(c.ocid),c]));
    const items=mode==='remove'?own.map(c=>{
      const remote=byHash.get(bindings.find(b=>b.character_id===c.id)?.identity_hash);
      return {...c,level:remote?.level??null,value:c.id};
    }):candidates.filter(c=>!bound.has(this.vault.fingerprint(c.ocid))).map(({ocid,...c})=>({...c,value:this.vault.fingerprint(ocid)}));
    items.sort((a,b)=>(b.level??-1)-(a.level??-1)||a.name.localeCompare(b.name,'ko')||(a.world??'').localeCompare(b.world??'','ko'));
    for(const [id,draft] of this.selections)if(this.now()-draft.createdAt>30*60_000||draft.scope===scope(ctx))this.selections.delete(id);
    const draft={id:randomUUID(),scope:scope(ctx),version,mode,items,selected:new Set(),createdAt:this.now()};
    this.selections.set(draft.id,draft);return draft;
  }
  selection(ctx,id,page=0,values=null) {
    const draft=this.selections.get(id);
    requireRule(draft&&draft.scope===scope(ctx)&&this.now()-draft.createdAt<=30*60_000,'선택 화면이 만료됐어요. 캐릭터 관리를 다시 열어 주세요.','STALE');
    requireRule((this.row(ctx)?.version??null)===draft.version,'API 연결이 변경됐어요. 캐릭터 관리를 다시 열어 주세요.','KEY_CHANGED');
    requireRule(Number.isSafeInteger(page)&&page>=0&&page<Math.max(1,Math.ceil(draft.items.length/25)),'페이지를 다시 선택해 주세요.');
    if(values!==null) {
      const allowed=draft.items.slice(page*25,(page+1)*25).map(c=>c.value);
      requireRule(Array.isArray(values)&&values.every(v=>allowed.includes(v)),'현재 페이지의 캐릭터를 선택해 주세요.');
      for(const v of allowed)draft.selected.delete(v);
      for(const v of values)draft.selected.add(v);
    }
    return draft;
  }
  async loadSelectionPage(ctx,id,page=0) {
    const draft=this.selection(ctx,id,page),row=this.row(ctx);
    if(!row||draft.powerLoaded)return draft;
    if(!draft.powerLoad)draft.powerLoad=this.loadSelectionPower(ctx,draft).finally(()=>{delete draft.powerLoad;});
    await draft.powerLoad;this.selection(ctx,id,page);return draft;
  }
  async loadSelectionPower(ctx,draft) {
    const candidates=new Map(this.candidates(ctx).map(c=>[this.vault.fingerprint(c.ocid),c]));
    const bindings=new Map(this.repo.db.prepare('SELECT character_id,identity_hash FROM personal_characters WHERE guild_id=? AND thread_id=? AND user_id=?').all(...args(ctx)).map(b=>[b.character_id,b.identity_hash]));
    const pending=[];
    for(const item of draft.items) {
      item.combatPower=null;
      const hash=draft.mode==='add'?item.value:bindings.get(item.value),remote=candidates.get(hash);
      if(!remote)continue;
      const cached=this.repo.db.prepare('SELECT combat_power,collected_at FROM personal_selection_power WHERE guild_id=? AND thread_id=? AND user_id=? AND identity_hash=?').get(...args(ctx),hash);
      if(cached&&this.now()-cached.collected_at<3600_000) {item.combatPower=cached.combat_power;continue;}
      pending.push({item,hash,remote});
    }
    for(const {item,hash,remote} of pending) {
      const key=`${scope(ctx)}:${draft.version}:${hash}`;
      try {
        let work=this.powerInflight.get(key);
        if(!work) {
          const session=this.connectionSession(ctx);
          work=(async()=>{
            const power=await session.api.combatPower(remote.ocid);session.assertCurrent();
            requireRule(typeof power==='string'&&/^\d+$/.test(power),'전투력 정보를 확인하지 못했어요.','NEXON_DATA');
            this.repo.db.prepare('INSERT INTO personal_selection_power VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,thread_id,user_id,identity_hash) DO UPDATE SET combat_power=excluded.combat_power,collected_at=excluded.collected_at').run(...args(ctx),hash,power,this.now());
            return power;
          })();
          this.powerInflight.set(key,work);
        }
        item.combatPower=await work;
      } catch(error) {
        if(['KEY_CHANGED','NEXON_STOPPED'].includes(error.code))throw error;
        item.combatPower=null;
        if(error.code==='NEXON_BUDGET')break;
      } finally {this.powerInflight.delete(key);}
    }
    this.selection(ctx,draft.id);
    draft.items.sort((a,b)=>{
      const left=a.combatPower==null?-1n:BigInt(a.combatPower),right=b.combatPower==null?-1n:BigInt(b.combatPower);
      return (left>right?-1:left<right?1:0)||(b.level??-1)-(a.level??-1)||a.name.localeCompare(b.name,'ko')||(a.world??'').localeCompare(b.world??'','ko');
    });
    // Freeze ordering for this selection session so page changes cannot move selected items.
    draft.powerLoaded=true;
  }
  completeSelection(ctx,id) {
    const draft=this.selection(ctx,id);
    requireRule(draft.selected.size>0,'캐릭터를 하나 이상 선택해 주세요.');
    const db=this.repo.db;db.exec('BEGIN IMMEDIATE');
    try {
      let result;
      if(draft.mode==='add') {
        const characters=this.candidates(ctx),available=new Set(characters.map(c=>this.vault.fingerprint(c.ocid)));
        requireRule([...draft.selected].every(v=>available.has(v)),'계정 목록이 변경됐어요. 추가할 캐릭터를 다시 선택해 주세요.','STALE');
        result=this.importCharacters(ctx,characters,{selected:draft.selected});
      } else {
        const state=this.service.snapshot(ctx),targets=[...draft.selected].map(id=>state.characters.find(c=>c.id===id&&c.active&&c.ownerId===ctx.userId));
        requireRule(targets.every(Boolean),'등록 상태가 변경됐어요. 삭제할 캐릭터를 다시 선택해 주세요.','STALE');
        const linked=state.parties.filter(p=>!p.archived&&p.characterIds.some(id=>draft.selected.has(id)));
        requireRule(!linked.length,`편성 중인 파티에서 먼저 제외해 주세요: ${linked.map(p=>p.name).join(', ').slice(0,300)}`,'IN_USE');
        for(const c of targets)c.active=false;
        db.prepare('UPDATE workspaces SET state_json=?,revision=revision+1 WHERE guild_id=? AND thread_id=?').run(JSON.stringify(state),ctx.guildId,ctx.threadId);
        result={removed:targets.length};
      }
      db.exec('COMMIT');this.selections.delete(id);return result;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  connectionSession(ctx) {
    const row=this.row(ctx);requireRule(row,'먼저 내 API 키를 연결해 주세요.','KEY_MISSING');
    const cacheKey=`${scope(ctx)}:${row.version}`;let api=this.clients.get(cacheKey);
    if(!api) {api=this.client(this.vault.open(row.sealed_key,scope(ctx)),row.fingerprint,()=>this.row(ctx)?.version===row.version);this.clients.set(cacheKey,api);}
    return {api,version:row.version,assertCurrent:()=>this.assertCurrent(ctx,row.version)};
  }
  isTracked(ctx,id) {return Boolean(this.repo.db.prepare('SELECT 1 FROM personal_characters WHERE guild_id=? AND thread_id=? AND character_id=? AND available=1').get(ctx.guildId,ctx.threadId,id));}
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
      db.prepare('DELETE FROM personal_candidates WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));
      db.prepare('DELETE FROM personal_selection_power WHERE guild_id=? AND thread_id=? AND user_id=?').run(...args(ctx));
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
  close() {this.stopped=true;for(const api of this.pending.values())api.close?.();this.pending.clear();for(const api of this.clients.values())api.close?.();this.clients.clear();this.selections.clear();}
}
