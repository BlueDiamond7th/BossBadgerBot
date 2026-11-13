import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, requireRule } from './errors.js';

export const kstDay=(time=Date.now())=>new Date(time+9*3600_000).toISOString().slice(0,10);
export class NexonClient {
  constructor({apiKey,fetchImpl=fetch,reserve=()=>true,sleep=delay,isActive=()=>true,gate={tail:Promise.resolve()}}) {
    this.apiKey=apiKey;this.fetch=fetchImpl;this.reserve=reserve;this.sleep=sleep;this.gate=gate;this.isActive=isActive;this.abort=new AbortController();
  }
  close() {this.abort.abort();}
  request(path,params={}) {
    const work=this.gate.tail.then(async()=>{
      requireRule(!this.abort.signal.aborted,'스펙 수집을 종료했어요.','NEXON_STOPPED');
      requireRule(this.isActive(),'API 연결이 변경되었어요.','KEY_CHANGED');
      requireRule(this.apiKey,'내 메이플스토리 API 키를 연결한 뒤 다시 시도해 주세요.','NEXON_CONFIG');
      requireRule(this.reserve(),'오늘의 넥슨 API 호출 예산을 모두 사용했어요. 내일 다시 시도해 주세요.','NEXON_BUDGET');
      try {
        const url=new URL(`https://open.api.nexon.com/maplestory/v1/${path}`);
        for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
        const response=await this.fetch(url,{headers:{'x-nxopen-api-key':this.apiKey},signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(10_000)])});
        const body=await response.json();
        if(!response.ok||body.error) {
          const code=/^OPENAPI\d{5}$/.test(body.error?.name)?body.error.name:'NEXON_HTTP';
          throw new DomainError('넥슨 정보를 조회하지 못했어요. 캐릭터 이름·API 설정·점검 상태를 확인하고 다시 시도해 주세요.',code);
        }
        requireRule(this.isActive(),'API 연결이 변경되었어요.','KEY_CHANGED');
        return body;
      } catch(error) {
        if(error instanceof DomainError) throw error;
        throw new DomainError('넥슨 API 응답이 지연되거나 올바르지 않아요. 잠시 후 다시 시도해 주세요.','NEXON_NETWORK');
      } finally {await this.sleep(250);}
    });
    this.gate.tail=work.catch(()=>{});return work;
  }
  async listCharacters() {
    const body=await this.request('character/list');
    requireRule(Array.isArray(body.account_list),'계정 캐릭터 목록을 확인하지 못했어요.','NEXON_DATA');
    const result=[],seen=new Set();
    for(const account of body.account_list) {
      requireRule(Array.isArray(account.character_list),'계정 캐릭터 목록이 올바르지 않아요.','NEXON_DATA');
      for(const c of account.character_list) {
        requireRule(typeof c.ocid==='string'&&c.ocid.length>0&&c.ocid.length<=256&&
          [c.character_name,c.world_name,c.character_class].every(x=>typeof x==='string'&&x.length>0&&x.length<=30)&&Number.isInteger(c.character_level),'캐릭터 목록 정보가 올바르지 않아요.','NEXON_DATA');
        if(seen.has(c.ocid))continue;seen.add(c.ocid);
        result.push({ocid:c.ocid,name:c.character_name,world:c.world_name,job:c.character_class,level:c.character_level});
      }
    }
    return result;
  }
  // date (YYYY-MM-DD, KST) reads a past day; the API keeps about 14 days.
  async scheduler(ocid,date=null) {
    const body=await this.request('scheduler/character-state',date?{ocid,date}:{ocid});
    // The live API returns "2026-11-11T00:00+09:00"; keep only the KST day.
    requireRule(typeof body.date==='string'&&/^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/.test(body.date)&&body.character_name,'스케줄러 정보가 없어요. 게임 접속 및 API 제공 상태를 확인해 주세요.','NEXON_NO_SCHEDULER');
    body.date=body.date.slice(0,10);
    const flag=value=>value===true||value==='true'?true:value===false||value==='false'?false:null;
    const count=value=>Number.isInteger(value)&&value>=0?value:null;
    const section=(items,boss=false)=>Array.isArray(items)?items.map(item=>{
      requireRule(typeof item.content_name==='string','스케줄러 항목이 올바르지 않아요.','NEXON_DATA');
      return boss?{name:item.content_name,difficulty:item.difficulty??'',cycle:item.cycle??'',complete:flag(item.complete_flag),registered:flag(item.registration_flag)}:
        {name:item.content_name,type:item.type??'',now:count(item.now_count),max:count(item.max_count),questState:['0','1','2'].includes(item.quest_state)?item.quest_state:null,registered:flag(item.registration_flag)};
    }):null;
    const data={date:body.date,daily:section(body.daily_contents),weekly:section(body.weekly_contents),bosses:section(body.boss_contents,true),weeklyBossCount:count(body.weekly_boss_clear_count),weeklyBossLimit:count(body.weekly_boss_clear_limit_count)};
    requireRule(data.daily!==null||data.weekly!==null||data.bosses!==null,'스케줄러 정보가 아직 제공되지 않아요.','NEXON_NO_SCHEDULER');
    return data;
  }
  async combatPower(ocid) {
    const stat=await this.request('character/stat',{ocid});
    const power=stat.final_stat?.find(s=>s.stat_name==='전투력')?.stat_value;
    requireRule(typeof power==='string'&&/^\d+$/.test(power),'전투력 정보가 아직 제공되지 않아요.','NEXON_DATA');
    return power;
  }
  async collect(name,ocid) {
    if(!ocid) ocid=(await this.request('id',{character_name:name})).ocid;
    requireRule(typeof ocid==='string'&&ocid.length>0,'캐릭터 식별자를 조회하지 못했어요.','NEXON_DATA');
    const basic=await this.request('character/basic',{ocid});
    requireRule(basic.character_name&&basic.world_name&&basic.character_class&&Number.isInteger(basic.character_level),'캐릭터 기본 정보가 아직 제공되지 않아요.','NEXON_DATA');
    const power=await this.combatPower(ocid);
    const gear=await this.request('character/item-equipment',{ocid});
    requireRule(Array.isArray(gear.item_equipment),'장비 정보가 아직 제공되지 않아요.','NEXON_DATA');
    const equipment={};
    for(const item of gear.item_equipment) {
      requireRule(item.item_equipment_slot&&item.item_name,'장비 슬롯 정보가 올바르지 않아요.','NEXON_DATA');
      // Keep stat-bearing fields, but not changing image URLs or descriptive text.
      equipment[item.item_equipment_slot]=Object.fromEntries(Object.entries(item).filter(([key])=>!['item_icon','item_description','item_shape_icon','item_shape_name'].includes(key)));
    }
    const skills={},unavailable=[];
    let grades=['0','1','2','3','4','hyperpassive','hyperactive'];
    if(basic.character_class==='듀얼블레이더') grades.push('1.5','2.5');
    if(basic.character_level>=200) grades.push('5');
    if(basic.character_level>=260) grades.push('6');
    for(const grade of grades) {
      try {
        const result=await this.request('character/skill',{ocid,character_skill_grade:grade});
        if(!Array.isArray(result.character_skill)) {unavailable.push(grade);continue;}
        skills[grade]={};
        for(const skill of result.character_skill) {
          requireRule(typeof skill.skill_name==='string'&&Number.isInteger(skill.skill_level),'스킬 레벨 정보가 올바르지 않아요.','NEXON_DATA');
          skills[grade][skill.skill_name]=skill.skill_level;
        }
      } catch(error) {
        if(error.code!=='OPENAPI00004') throw error;
        unavailable.push(grade);
      }
    }
    for(const [grade,path,field,nameField,levelField,minLevel] of [
      ['V코어','vmatrix','character_v_core_equipment','v_core_name','v_core_level',200],
      ['HEXA코어','hexamatrix','character_hexa_core_equipment','hexa_core_name','hexa_core_level',260],
    ]) {
      if(basic.character_level<minLevel) continue;
      try {
        const result=await this.request(`character/${path}`,{ocid});
        if(!Array.isArray(result[field])) {unavailable.push(grade);continue;}
        skills[grade]={};
        for(const core of result[field]) {
          requireRule(typeof core[nameField]==='string'&&Number.isInteger(core[levelField]),'코어 정보가 올바르지 않아요.','NEXON_DATA');
          // Slot movement alone is not a skill upgrade. Keep duplicate core levels sorted.
          const name=core[nameField];
          skills[grade][name]=Math.max(skills[grade][name]??0,core[levelField]);
          if(core.hexa_core_event_level!=null) skills[grade][`${name} (이벤트)`]=core.hexa_core_event_level;
        }
      } catch(error) {if(error.code!=='OPENAPI00004') throw error;unavailable.push(grade);}
    }
    return {ocid,profile:{name:basic.character_name,world:basic.world_name,job:basic.character_class},
      data:{level:basic.character_level,combatPower:power,equipment,skills,unavailable,preset:gear.preset_no??null}};
  }
}
