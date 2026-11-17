import { DomainError, requireRule } from './errors.js';
import { BOSSES, DIFFICULTIES } from './catalog.js';

export const MAX_PARTY_MEMBERS=6, MAX_PARTY_BOSSES=12;
const squash=v=>String(v??'').normalize('NFC').replace(/\s+/g,'').toLocaleLowerCase();
const DIFFICULTY_ALIASES={'이지':'이지','easy':'이지','노말':'노말','노멀':'노말','normal':'노말','하드':'하드','hard':'하드','카오스':'카오스','chaos':'카오스','익스트림':'익스트림','익스':'익스트림','extreme':'익스트림'};
// Short names players use; full catalog names (spaces ignored) always work too.
const BOSS_ALIASES={'칼로스':'kalos','대적자':'adversary','흉성':'star','검마':'blackmage','검은마법사':'blackmage','세렌':'seren','진힐라':'jinhilla','힐라':'jinhilla','가엔슬':'slime','슬라임':'slime','가디언엔젤슬라임':'slime','듄켈':'darknell'};
const bossByName=name=>{const key=squash(name);return BOSSES.find(b=>squash(b.name)===key||b.id===key)??BOSSES.find(b=>b.id===BOSS_ALIASES[key]);};

// Boss dropdowns for the creation form: 49 boss/difficulty pairs do not fit one 25-option menu.
export function bossOptionGroups() {
  const all=BOSSES.flatMap(b=>b.difficulties.map(d=>({label:`${d} ${b.name}`,value:`${b.id}:${d}`,grandis:b.maxParty===3||['kalos','kaling'].includes(b.id)})));
  return [all.filter(o=>!o.grandis),all.filter(o=>o.grandis)].map(group=>group.map(({grandis,...o})=>o));
}
export function bossesFromValues(values) {
  return values.map(v=>{const [bossId,difficulty]=String(v).split(':');return {bossId,difficulty};});
}
// "노멀 찬란한 흉성, 하드 대적자, 칼로스 카오스" → [{bossId,difficulty}]; difficulty may come first or last.
export function parseBossList(text) {
  const bosses=[],errors=[];
  for(const raw of String(text??'').split(/[,，\n]/).map(t=>t.trim()).filter(Boolean)) {
    const words=raw.split(/\s+/),first=DIFFICULTY_ALIASES[words[0].toLocaleLowerCase()],last=DIFFICULTY_ALIASES[words.at(-1).toLocaleLowerCase()];
    const difficulty=first??last,name=(first?words.slice(1):last?words.slice(0,-1):words).join(' '),boss=name&&bossByName(name);
    if(!difficulty||!boss) {errors.push(`${raw}: 난이도와 보스 이름을 확인해 주세요. 예: 노멀 찬란한 흉성`);continue;}
    if(!boss.difficulties.includes(difficulty)) {errors.push(`${raw}: ${boss.name}에는 ${difficulty} 난이도가 없어요.`);continue;}
    bosses.push({bossId:boss.id,difficulty});
  }
  return {bosses,errors};
}
// "도토리, 모찌빵" → character ids among active characters in this room (names are case-insensitive).
export function parseCharacterList(state,text) {
  const ids=[],errors=[];
  for(const raw of String(text??'').split(/[,，\n]/).map(t=>t.trim()).filter(Boolean)) {
    const found=state.characters.filter(c=>c.active&&c.name.toLocaleLowerCase()===raw.toLocaleLowerCase());
    if(found.length===1) ids.push(found[0].id);
    else errors.push(found.length?`${raw}: 같은 이름의 캐릭터가 여러 개예요. 캐릭터 추가 메뉴에서 골라 주세요.`:`${raw}: 이 보스방에 등록된 캐릭터가 아니에요.`);
  }
  return {ids,errors};
}
// Picking people with @ search: each person's strongest character, kept in one world.
export function pickRepresentatives(state,userIds,stats=null) {
  const power=id=>{try {const v=stats?.get(id)?.power??stats?.get(id);return v!=null&&/^\d+$/.test(String(v))?BigInt(v):-1n;} catch {return -1n;}};
  const ids=[],errors=[];let world=null;
  for(const userId of userIds) {
    const own=state.characters.filter(c=>c.active&&c.ownerId===userId&&(!world||!c.world||c.world===world)).sort((a,b)=>power(b.id)>power(a.id)?1:power(b.id)<power(a.id)?-1:0);
    if(!own.length) {errors.push(`<@${userId}>: ${world?`${world} 월드에 `:''}등록한 캐릭터가 없어요.`);continue;}
    ids.push(own[0].id);world??=own[0].world??null;
  }
  return {ids,errors};
}
// Creates the party, then adds what passes the existing party rules. A modal loses its input on
// failure, so rule violations are reported as skipped items instead of rejecting the whole form.
export function createPartyWith(service,ctx,{name,characterIds=[],bosses=[]},rid) {
  requireRule(characterIds.length<=MAX_PARTY_MEMBERS,`캐릭터는 최대 ${MAX_PARTY_MEMBERS}명까지 고를 수 있어요.`);
  const party=service.createParty(ctx,name,`${rid}:party`),added=[],skipped=[];
  const state=service.snapshot(ctx),nameOf=id=>state.characters.find(c=>c.id===id)?.name??'캐릭터';
  for(const [i,id] of [...new Set(characterIds)].entries()) {
    try {service.addCharacter(ctx,party.id,id,`${rid}:c${i}`);added.push(state.characters.find(c=>c.id===id));}
    catch(error) {if(!(error instanceof DomainError)) throw error;skipped.push(`${nameOf(id)}: ${error.message}`);}
  }
  for(const [i,b] of bosses.entries()) {
    const label=`${b.difficulty} ${BOSSES.find(x=>x.id===b.bossId)?.name??b.bossId}`;
    if(i>=MAX_PARTY_BOSSES) {skipped.push(`${label}: 보스는 최대 ${MAX_PARTY_BOSSES}개까지 등록해요.`);continue;}
    if(!DIFFICULTIES.includes(b.difficulty)) {skipped.push(`${label}: 지원하지 않는 난이도예요.`);continue;}
    try {service.addBoss(ctx,party.id,b.bossId,b.difficulty,`${rid}:b${i}`);}
    catch(error) {if(!(error instanceof DomainError)) throw error;skipped.push(`${label}: ${error.message}`);}
  }
  return {party:service.getParty(ctx,party.id),added,skipped};
}
// One public message per batch: "@owner **캐릭터**이(가) **파티** 파티에 편성됐어요."
export function memberMentions(characters,partyName,actorId) {
  const byOwner=new Map();
  for(const c of characters) if(c&&c.ownerId!==actorId) byOwner.set(c.ownerId,[...(byOwner.get(c.ownerId)??[]),c.name]);
  if(!byOwner.size) return null;
  return {users:[...byOwner.keys()],content:[...byOwner].map(([u,names])=>`<@${u}> **${names.join(', ')}**이(가) **${partyName}** 파티에 편성됐어요.`).join('\n').slice(0,1900)};
}
