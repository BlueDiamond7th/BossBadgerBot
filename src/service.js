import { randomUUID } from 'node:crypto';
import { requireRule } from './errors.js';
import { bossById } from './catalog.js';

const text=(value,label,max=40)=> {
  requireRule(typeof value==='string'&&value.trim().length>0,`${label}을(를) 입력해 주세요.`);
  const v=value.trim().normalize('NFC');
  requireRule(v.length<=max,`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  requireRule(!/[\x00-\x1f\x7f]/u.test(v),`${label}에 줄바꿈이나 제어문자를 넣을 수 없어요.`);
  return v;
};
const activeCharacter=(s,id)=> {
  const c=s.characters.find(c=>c.id===id&&c.active);
  requireRule(c,'현재 스레드에 등록된 캐릭터를 선택해 주세요.','NOT_FOUND'); return c;
};
const party=(s,id,includeArchived=false)=> {
  const p=s.parties.find(p=>p.id===id&&(includeArchived||!p.archived));
  requireRule(p,'이 스레드에서 파티를 찾을 수 없어요.','NOT_FOUND'); return p;
};
function editable(ctx,p,version) {
  requireRule(ctx.isManager||p.creatorId===ctx.userId,'파티를 만든 사람 또는 스레드 관리 권한이 있는 사람만 수정할 수 있어요.','FORBIDDEN');
  if(version!==undefined&&version!==null) requireRule(p.version===version,'파티가 변경됐어요. 파티 정보를 다시 열어 주세요.','STALE');
}
const optionalText=(value,label)=>value==null?null:text(value,label,30);
const sameIdentity=(c,name,world)=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase()&&(!c.world||!world||c.world===world);
const worlds=characters=>new Set(characters.map(c=>c?.world).filter(Boolean));
export class PartyService {
  constructor(repository) { this.repo=repository; }
  snapshot(ctx) { return this.repo.read(ctx); }
  start(ctx,rid) { return this.repo.mutate(ctx,rid,'start',()=>({started:true}),{allowCreate:true}); }
  setBoard(ctx,messageId,rid) {return this.repo.mutate(ctx,rid,'board',s=>{s.boardMessageId=messageId;return true;});}
  register(ctx,input,rid) {
    return this.repo.mutate(ctx,rid,'character.register',s=>{
      const name=text(input.name,'캐릭터명',30), world=optionalText(input.world,'월드'), job=optionalText(input.job,'직업');
      requireRule(!s.characters.some(c=>c.active&&sameIdentity(c,name,world)),'해당 이름의 캐릭터가 이미 등록되어 있어요. 월드 미확인 캐릭터는 이름으로 중복을 확인해요.','DUPLICATE');
      const c={id:randomUUID(),ownerId:ctx.userId,name,world,job,active:true}; s.characters.push(c); return c;
    });
  }
  editCharacter(ctx,id,input,rid) {
    return this.repo.mutate(ctx,rid,'character.edit',s=>{
      const c=activeCharacter(s,id);
      requireRule(c.ownerId===ctx.userId,'본인이 등록한 캐릭터만 수정할 수 있어요.','FORBIDDEN');
      const next={...c,name:text(input.name??c.name,'캐릭터명',30),world:optionalText(input.world??c.world,'월드'),job:optionalText(input.job??c.job,'직업')};
      requireRule(!s.characters.some(x=>x.active&&x.id!==id&&sameIdentity(x,next.name,next.world)),'해당 이름의 캐릭터가 이미 등록되어 있어요. 월드 미확인 캐릭터는 이름으로 중복을 확인해요.','DUPLICATE');
      // An identity/world change must not silently change existing party composition.
      if(next.name!==c.name||next.world!==c.world) requireRule(!s.parties.some(p=>!p.archived&&p.characterIds.includes(id)),'편성 중인 캐릭터의 이름·월드는 파티에서 제외한 뒤 수정해 주세요.','IN_USE');
      Object.assign(c,next); return c;
    });
  }
  unregister(ctx,id,rid) {
    return this.repo.mutate(ctx,rid,'character.unregister',s=>{
      const c=activeCharacter(s,id);requireRule(c.ownerId===ctx.userId,'본인 캐릭터만 등록 해제할 수 있어요.','FORBIDDEN');
      const linked=s.parties.filter(p=>!p.archived&&p.characterIds.includes(id));
      requireRule(linked.length===0,`편성 중인 파티에서 먼저 제외해 주세요: ${linked.map(p=>p.name).join(', ').slice(0,300)}`,'IN_USE');
      c.active=false;return c;
    });
  }
  createParty(ctx,name,rid) {
    return this.repo.mutate(ctx,rid,'party.create',s=>{
      const p={id:randomUUID(),name:text(name,'파티 이름',60),creatorId:ctx.userId,characterIds:[],bosses:[],archived:false,version:1};s.parties.push(p);return p;
    });
  }
  renameParty(ctx,id,name,rid,version) {
    return this.repo.mutate(ctx,rid,'party.rename',s=>{const p=party(s,id);editable(ctx,p,version);p.name=text(name,'파티 이름',60);p.version++;return p;});
  }
  addCharacter(ctx,id,characterId,rid,version) {
    return this.repo.mutate(ctx,rid,'party.add-character',s=>{
      const p=party(s,id);editable(ctx,p,version);const c=activeCharacter(s,characterId);
      // Runtime derives eligible owners from Discord, never from a command argument.
      requireRule(ctx.eligibleOwnerIds instanceof Set&&ctx.eligibleOwnerIds.has(c.ownerId),'이 캐릭터의 등록자가 현재 스레드 참가자가 아니에요.','NOT_MEMBER');
      requireRule(!p.characterIds.includes(c.id),'이미 편성된 캐릭터예요.','DUPLICATE');
      requireRule(!p.characterIds.some(cid=>s.characters.find(x=>x.id===cid)?.ownerId===c.ownerId),'한 파티에는 한 사람당 캐릭터 하나를 선택해 주세요. 먼저 기존 캐릭터를 제외하면 교체할 수 있어요.');
      requireRule(worlds([...p.characterIds.map(cid=>s.characters.find(x=>x.id===cid)),c]).size<=1,'첫 버전에서는 같은 월드의 캐릭터로 편성해 주세요.');
      p.characterIds.push(c.id);p.version++;return p;
    });
  }
  removeCharacter(ctx,id,characterId,rid,version) {
    return this.repo.mutate(ctx,rid,'party.remove-character',s=>{const p=party(s,id);editable(ctx,p,version);requireRule(p.characterIds.includes(characterId),'이 파티에 편성된 캐릭터가 아니에요.');p.characterIds=p.characterIds.filter(x=>x!==characterId);p.version++;return p;});
  }
  addBoss(ctx,id,bossId,difficulty,rid,version) {
    return this.repo.mutate(ctx,rid,'party.add-boss',s=>{
      const p=party(s,id);editable(ctx,p,version);const b=bossById(bossId);
      requireRule(b?.difficulties.includes(difficulty),'해당 보스의 지원 난이도를 선택해 주세요.');
      requireRule(!p.bosses.some(x=>x.bossId===bossId),'이미 등록된 보스예요. 난이도를 바꾸려면 기존 보스를 제외한 뒤 추가해 주세요.','DUPLICATE');
      p.bosses.push({bossId,difficulty});p.version++;return p;
    });
  }
  removeBoss(ctx,id,bossId,rid,version) {
    return this.repo.mutate(ctx,rid,'party.remove-boss',s=>{const p=party(s,id);editable(ctx,p,version);requireRule(p.bosses.some(b=>b.bossId===bossId),'이 파티에 등록된 보스가 아니에요.');p.bosses=p.bosses.filter(b=>b.bossId!==bossId);p.version++;return p;});
  }
  copyParty(ctx,id,name,rid) {
    return this.repo.mutate(ctx,rid,'party.copy',s=>{
      const source=party(s,id,true);
      const ids=source.characterIds.filter(cid=>{const c=s.characters.find(c=>c.id===cid);return c?.active&&ctx.eligibleOwnerIds?.has(c.ownerId);});
      requireRule(worlds(ids.map(id=>s.characters.find(c=>c.id===id))).size<=1,'복사할 캐릭터의 월드가 달라졌어요. 원본 구성을 정리한 뒤 다시 복사해 주세요.');
      const p={...source,id:randomUUID(),name:text(name??`${source.name.slice(0,55)} 복사`,'파티 이름',60),creatorId:ctx.userId,characterIds:ids,bosses:source.bosses.map(b=>({...b})),version:1,archived:false};s.parties.push(p);return p;
    });
  }
  archive(ctx,id,archived,rid,version) {
    return this.repo.mutate(ctx,rid,'party.archive',s=>{
      const p=party(s,id,true);editable(ctx,p,version);
      if(!archived) {
        const characters=p.characterIds.map(id=>s.characters.find(c=>c.id===id));
        requireRule(characters.every(c=>c?.active),'등록 해제된 캐릭터가 포함돼 있어요. 구성 복사로 사용 가능한 캐릭터만 옮겨 새 파티를 만들어 주세요.','INACTIVE_CHARACTER');
        requireRule(characters.every(c=>ctx.eligibleOwnerIds instanceof Set&&ctx.eligibleOwnerIds.has(c.ownerId)),'현재 채널/스레드에 참가할 수 없는 등록자가 포함돼 있어요. 참가 자격을 확인하거나 구성 복사로 새 파티를 만들어 주세요.','NOT_MEMBER');
        requireRule(worlds(characters).size<=1,'캐릭터의 월드가 달라졌어요. 같은 월드로 수정한 뒤 복원해 주세요.','MIXED_WORLD');
      }
      p.archived=archived;p.version++;return p;
    });
  }
  getParty(ctx,id,includeArchived=false) {return party(this.snapshot(ctx),id,includeArchived);}
  warnings(state,p) {
    const notices=p.characterIds.some(id=>!state.characters.find(c=>c.id===id)?.world)?['월드 미확인 캐릭터가 있어요. API 연결 후 같은 월드인지 확인해 주세요.']:[];
    return notices.concat(state.parties.filter(other=>!other.archived&&other.id!==p.id&&other.characterIds.some(id=>p.characterIds.includes(id))&&other.bosses.some(b=>p.bosses.some(x=>x.bossId===b.bossId))).map(other=>`${other.name}: 같은 캐릭터의 보스가 겹쳐요. 보상 주기를 확인해 주세요.`));
  }
}
