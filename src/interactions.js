import { MessageFlags } from 'discord.js';
import { contextFor, supportedChannel, eligibleOwners, requireEditable, visibleError } from './access.js';
import { requireRule } from './errors.js';
import { bossById } from './catalog.js';
import * as view from './views.js';

export function createHandler({service,guildId,tracker=null,connections=null,onConnectionChanged=()=>{},verifyContext=contextFor,resolveOwners=eligibleOwners,refreshBoard=async()=>{}}) {
  function specs(ctx,id,index=0,page=0) {
    requireRule(tracker,'스펙 추적 기능을 사용할 수 없어요. 봇을 업데이트해 주세요.');
    return view.specDetail(tracker.character(ctx,id),tracker.history(ctx,id),tracker.manualHistory(ctx,id),ctx,index,page);
  }
  function connection(ctx) {
    requireRule(connections,'개인 API 연결 기능을 사용할 수 없어요. 봇을 업데이트해 주세요.');
    return view.connectionPanel(connections.status(ctx));
  }
  function disconnect(ctx) {
    requireRule(connections,'개인 API 연결 기능을 사용할 수 없어요.');
    const row=connections.row(ctx);requireRule(row,'연결된 API 키가 없어요.');
    return view.disconnectConfirmation(row.version);
  }
  function imported(ctx,result) {
    return {...view.roster(service.snapshot(ctx),0,ctx.userId),content:result.cached?'최근 동기화한 캐릭터 목록입니다. 1분 후 다시 동기화할 수 있어요.':`캐릭터 목록 동기화 완료: 추가 ${result.added}개 · 갱신 ${result.updated}개 · 이름 충돌로 건너뜀 ${result.conflicts}개. 스펙·스케줄러는 자동 수집하거나 개별 갱신할 수 있어요.`};
  }
  function scheduler(ctx,id,index=0,page=0) {
    requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');
    return view.schedulerDetail(tracker.character(ctx,id,true),tracker.schedulerHistory(ctx,id),index,page);
  }
  async function respond(i,payload) { return i.editReply({content:null,embeds:[],components:[],allowedMentions:{parse:[]},...payload}); }
  async function getEligible(ctx,i,ids) {ctx.eligibleOwnerIds=await resolveOwners(i.channel,ids);return ctx;}
  async function detail(ctx,i,id) {
    const p=service.getParty(ctx,id,true),s=service.snapshot(ctx);
    await getEligible(ctx,i,p.characterIds.map(cid=>s.characters.find(c=>c.id===cid)?.ownerId).filter(Boolean));
    return view.partyDetail(s,p,ctx,service.warnings(s,p));
  }
  async function withPartyOwners(ctx,i,id) {
    const s=service.snapshot(ctx),p=service.getParty(ctx,id,true);
    return getEligible(ctx,i,p.characterIds.map(cid=>s.characters.find(c=>c.id===cid)?.ownerId).filter(Boolean));
  }
  async function candidate(ctx,i,characterId) {
    const c=service.snapshot(ctx).characters.find(c=>c.id===characterId&&c.active);
    requireRule(c,'현재 스레드에 등록된 캐릭터를 선택해 주세요.','NOT_FOUND');
    return getEligible(ctx,i,[c.ownerId]);
  }
  async function autocomplete(i) {
    let timer;
    try {
      // Leave time for Discord delivery; slow permission checks must not expose data.
      const remaining=Math.max(0,2000-(Date.now()-(i.createdTimestamp??Date.now())));
      if(remaining===0) {await i.respond([]);return;}
      const ctx=await Promise.race([
        verifyContext(i,guildId),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(null),remaining);}),
      ]);
      clearTimeout(timer);
      if(!ctx) {await i.respond([]);return;}
      const s=service.snapshot(ctx),focused=i.options.getFocused(true),query=String(focused.value).toLocaleLowerCase();
      const sub=i.options.getSubcommand();let items=[];
      if(focused.name==='파티') items=s.parties.filter(p=>sub==='복원'?p.archived:sub==='복사'?true:!p.archived).map(p=>({name:p.name,value:p.id}));
      if(focused.name==='캐릭터') {
        let chars=s.characters.filter(c=>c.active);
        if(i.commandName==='캐릭터'&&sub!=='스펙') chars=chars.filter(c=>c.ownerId===ctx.userId);
        if(i.commandName==='파티'&&sub==='캐릭터제외') {
          const id=i.options.getString('파티'),p=s.parties.find(p=>p.id===id&&!p.archived);
          chars=p?chars.filter(c=>p.characterIds.includes(c.id)):[];
        }
        items=chars.map(c=>({name:`${c.name} · ${c.world??'월드 미확인'} · ${c.job??'직업 미확인'}`,value:c.id}));
      }
      await i.respond(items.filter(item=>item.name.toLocaleLowerCase().includes(query)).slice(0,25).map(item=>({...item,name:item.name.slice(0,100)})));
    } catch { if(!i.responded) await i.respond([]).catch(()=>{}); }
    finally {clearTimeout(timer);}
  }
  return async function handle(i) {
    if(i.isAutocomplete()) return autocomplete(i);
    if(!i.isChatInputCommand()&&!i.isButton()&&!i.isStringSelectMenu()&&!i.isModalSubmit()) return;
    let changed=false;
    try {
      // Opening a blank modal reveals no saved data. Recheck live membership on submit.
      if(i.isButton()&&['mp:apikey','mp:create'].includes(i.customId)) {
        requireRule(i.inGuild()&&i.guildId===guildId&&supportedChannel(i.channel),'설정한 서버의 일반 채널 또는 스레드에서 사용해 주세요.');
        return await i.showModal(i.customId==='mp:apikey'?view.registrationModal():view.creationModal());
      }
      if((i.isButton()||i.isStringSelectMenu()||i.isModalSubmit())&&i.message?.flags?.has(MessageFlags.Ephemeral)) await i.deferUpdate();
      else await i.deferReply({flags:MessageFlags.Ephemeral});
      const ctx=await verifyContext(i,guildId),rid=i.id;
      let payload;
      if(i.isChatInputCommand()) {
        const sub=i.options.getSubcommand(),get=n=>i.options.getString(n),pid=get('파티');
        if(i.commandName==='보스방') {
          if(sub==='시작') {service.start(ctx,rid);changed=true;}
          payload=view.board(service.snapshot(ctx));
        } else if(i.commandName==='캐릭터') {
          if(sub==='연결'||sub==='등록') payload=connection(ctx);
          if(sub==='연결해제') payload=disconnect(ctx);
          if(sub==='동기화') {connection(ctx);payload=imported(ctx,await connections.refresh(ctx));changed=true;onConnectionChanged();}
          if(sub==='스케줄러') payload=scheduler(ctx,get('캐릭터'));
          if(sub==='스케줄러갱신') {requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');const result=await tracker.syncScheduler(ctx,get('캐릭터'));payload=scheduler(ctx,get('캐릭터'));if(result.cached)payload.content='5분 이내 수집한 기록을 보여드려요.';}
          if(sub==='목록') {
            const owner=i.options.getUser('등록자')?.id??'all',s=service.snapshot(ctx);
            const shown=view.paginate(s.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner)),0,10).items;
            await getEligible(ctx,i,shown.map(c=>c.ownerId));payload=view.roster(s,0,owner,ctx.eligibleOwnerIds);
          }
          if(sub==='수정') {service.editCharacter(ctx,get('캐릭터'),{name:get('이름')??undefined},rid);changed=true;payload=view.roster(service.snapshot(ctx),0,ctx.userId);}
          if(sub==='스펙') payload=specs(ctx,get('캐릭터'));
          if(sub==='스펙갱신') {requireRule(tracker,'스펙 추적 기능을 사용할 수 없어요.');const result=await tracker.sync(ctx,get('캐릭터'));changed=!result.cached;payload=specs(ctx,get('캐릭터'));}
          if(sub==='환산기록') {requireRule(tracker,'스펙 추적 기능을 사용할 수 없어요.');tracker.recordManual(ctx,get('캐릭터'),i.options.getNumber('수치'),get('종류'),rid);payload=specs(ctx,get('캐릭터'));}
          if(sub==='해제') {service.unregister(ctx,get('캐릭터'),rid);changed=true;payload={content:'내 캐릭터의 보스방 등록을 해제했어요. 과거 보관 데이터는 유지돼요.'};}
        } else if(i.commandName==='파티') {
          let p;
          if(sub==='생성') {p=service.createParty(ctx,get('이름'),rid);changed=true;}
          if(sub==='목록') payload=view.partyList(service.snapshot(ctx),0,i.options.getBoolean('보관함')??false);
          if(sub==='정보') payload=await detail(ctx,i,pid);
          if(sub==='캐릭터추가') {await candidate(ctx,i,get('캐릭터'));p=service.addCharacter(ctx,pid,get('캐릭터'),rid);changed=true;}
          if(sub==='캐릭터제외') {p=service.removeCharacter(ctx,pid,get('캐릭터'),rid);changed=true;}
          if(sub==='보스추가') {p=service.addBoss(ctx,pid,get('보스'),get('난이도'),rid);changed=true;}
          if(sub==='보스제외') {p=service.removeBoss(ctx,pid,get('보스'),rid);changed=true;}
          if(sub==='복사') {await withPartyOwners(ctx,i,pid);p=service.copyParty(ctx,pid,get('이름'),rid);changed=true;}
          if(sub==='이름변경') {p=service.renameParty(ctx,pid,get('이름'),rid);changed=true;}
          if(sub==='보관'||sub==='복원') {const existing=service.getParty(ctx,pid,true);requireEditable(ctx,existing);requireRule(sub==='복원'?existing.archived:!existing.archived,sub==='복원'?'이미 활성 상태인 파티예요.':'이미 보관한 파티예요.');payload=view.archiveConfirmation(existing);}
          if(p) payload=await detail(ctx,i,p.id);
        }
      } else if(i.isModalSubmit()) {
        if(i.customId==='mp:modal:register') payload=connection(ctx);
        if(i.customId==='mp:modal:apikey') {connection(ctx);payload=imported(ctx,await connections.connect(ctx,i.fields.getTextInputValue('apikey')));changed=true;onConnectionChanged();}
        if(i.customId==='mp:modal:create') {const p=service.createParty(ctx,i.fields.getTextInputValue('name'),rid);changed=true;payload=await detail(ctx,i,p.id);}
      } else {
        const [prefix,action,id,a,b]=i.customId.split(':');requireRule(prefix==='mp','지원하지 않는 동작이에요.');
        const selected=i.values?.[0];
        if(action==='register') payload=connection(ctx);
        if(action==='accountsync') {connection(ctx);payload=imported(ctx,await connections.refresh(ctx));changed=true;onConnectionChanged();}
        if(action==='disconnectask') payload=disconnect(ctx);
        if(action==='disconnect') {connection(ctx);connections.disconnect(ctx,id);payload={...connection(ctx),content:'내 API 연결을 해제했어요. 키를 삭제하고 자동 추적을 중단했습니다. 기존 캐릭터·파티·기록은 유지됩니다.'};}
        if(action==='schedulerpicker') payload=view.schedulerPicker(service.snapshot(ctx),ctx.userId,Number(id));
        if(action==='scheduler'||action==='selectscheduler') payload=scheduler(ctx,selected??id,Number(a)||0,Number(b)||0);
        if(action==='schedulersync') {requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');const result=await tracker.syncScheduler(ctx,id);payload=scheduler(ctx,id);if(result.cached)payload.content='5분 이내 수집한 기록을 보여드려요.';}
        if(action==='specpicker') payload=view.specPicker(service.snapshot(ctx),Number(id));
        if(action==='selectspec'||action==='spec') payload=specs(ctx,selected??id,Number(a)||0,Number(b)||0);
        if(action==='specsync') {requireRule(tracker,'스펙 추적 기능을 사용할 수 없어요.');const result=await tracker.sync(ctx,id);changed=!result.cached;payload=specs(ctx,id);}
        if(action==='board') {payload=view.board(service.snapshot(ctx));changed=true;}
        if(action==='roster') {
          const s=service.snapshot(ctx),page=Number(a),shown=view.paginate(s.characters.filter(c=>c.active&&(id==='all'||c.ownerId===id)),page,10).items;
          await getEligible(ctx,i,shown.map(c=>c.ownerId));payload=view.roster(s,page,id,ctx.eligibleOwnerIds);
        }
        if(action==='parties') payload=view.partyList(service.snapshot(ctx),Number(a),id==='archived');
        if(action==='open'||action==='detail') payload=await detail(ctx,i,selected??id);
        if(action==='addmember'||action==='delmember') {
          const p=requireEditable(ctx,service.getParty(ctx,id),Number(b)),s=service.snapshot(ctx);
          if(action==='addmember') await getEligible(ctx,i,s.characters.filter(c=>c.active).map(c=>c.ownerId));
          payload=view.memberPicker(s,p,Number(a),action==='delmember',ctx.eligibleOwnerIds??null);
        }
        if(action==='selectmember') {await candidate(ctx,i,selected);service.addCharacter(ctx,id,selected,rid,Number(a));changed=true;payload=await detail(ctx,i,id);}
        if(action==='removemember') {service.removeCharacter(ctx,id,selected,rid,Number(a));changed=true;payload=await detail(ctx,i,id);}
        if(action==='addboss'||action==='delboss') {const p=requireEditable(ctx,service.getParty(ctx,id),Number(b));payload=view.bossPicker(p,action==='delboss');}
        if(action==='selectboss') {const p=requireEditable(ctx,service.getParty(ctx,id),Number(a));requireRule(bossById(selected),'보스를 다시 선택해 주세요.');payload=view.difficultyPicker(p,selected);}
        if(action==='difficulty') {service.addBoss(ctx,id,b,selected,rid,Number(a));changed=true;payload=await detail(ctx,i,id);}
        if(action==='removeboss') {service.removeBoss(ctx,id,selected,rid,Number(a));changed=true;payload=await detail(ctx,i,id);}
        if(action==='copy') {await withPartyOwners(ctx,i,id);const p=service.copyParty(ctx,id,null,rid);changed=true;payload=await detail(ctx,i,p.id);}
        if(action==='archive') {const p=requireEditable(ctx,service.getParty(ctx,id,true),Number(a));payload=view.archiveConfirmation(p);}
        if(action==='confirmarchive') {
          requireEditable(ctx,service.getParty(ctx,id,true),Number(a));
          if(b==='restore') await withPartyOwners(ctx,i,id);
          service.archive(ctx,id,b==='store',rid,Number(a));changed=true;payload=await detail(ctx,i,id);
        }
      }
      requireRule(payload,'지원하지 않는 동작이에요. 명령어를 다시 열어 주세요.');
      const shared=i.isChatInputCommand()&&((i.commandName==='파티'&&['목록','정보'].includes(i.options.getSubcommand()))||(i.commandName==='캐릭터'&&i.options.getSubcommand()==='목록'));
      if(shared) {
        await respond(i,{content:'조회한 내용을 채널에 게시합니다.'});
        if(i.commandName==='파티'&&i.options.getSubcommand()==='정보') payload=view.publicParty(payload,i.options.getString('파티'));
        await i.followUp({...payload,allowedMentions:{parse:[]}});
        await i.deleteReply();
      } else await respond(i,payload);
      if(changed) {
        try {await refreshBoard(i,ctx);} catch(error) {
          console.warn('[board-refresh]',error.code??error.name);
          await i.followUp({content:'저장은 완료했지만 공용 관리판을 갱신하지 못했어요. 봇의 채널 권한을 확인하고 /보스방 시작을 다시 실행해 주세요.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}}).catch(()=>{});
        }
      }
    } catch(error) {
      console.warn('[interaction]',error.code??error.name);
      const payload={content:visibleError(error),embeds:[],components:[],allowedMentions:{parse:[]}};
      try {if(i.deferred||i.replied) await i.editReply(payload);else await i.reply({...payload,flags:MessageFlags.Ephemeral});} catch { console.warn('[reply] response-unavailable'); }
      // Persisted mutations remain valid even if rendering or Discord delivery failed.
      if(changed) {
        try {const ctx=await verifyContext(i,guildId);await refreshBoard(i,ctx);} catch {console.warn('[board-refresh] retry-later');}
      }
    }
  };
}
