import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { contextFor, supportedChannel, eligibleOwners, requireEditable, visibleError } from './access.js';
import { requireRule } from './errors.js';
import { formatMeso } from './revenue.js';
import { bossById } from './catalog.js';
import * as view from './views.js';
import { createScheduleInteractions } from './schedule-interactions.js';

export function createHandler({service,guildId,tracker=null,connections=null,records=null,prices=null,distributions=null,schedules=null,scheduleWorker=null,onConnectionChanged=()=>{},verifyContext=contextFor,resolveOwners=eligibleOwners,refreshBoard=async()=>{}}) {
  const scheduleUI=schedules?createScheduleInteractions({schedules,resolveOwners}):null;
  const privatePanels=new Map();
  const priceMap=gid=>prices?.all(gid).prices??{};
  const need=(feature,label)=>{requireRule(feature,`${label} 기능을 사용할 수 없어요. 봇을 업데이트해 주세요.`);return feature;};
  // Edits the shared card the button or modal came from; ephemeral panels are replaced by the normal reply.
  async function editPublic(i,payload) {if(i.message&&!i.message.flags?.has(MessageFlags.Ephemeral)) await i.message.edit({...payload,allowedMentions:{parse:[]}}).catch(()=>console.warn('[card] edit-failed'));}
  // Opening a modal must be the first response, so these checks use stored data only; submit rechecks membership.
  function quickContext(i) {
    requireRule(i.inGuild()&&i.guildId===guildId&&supportedChannel(i.channel),'설정한 서버의 일반 채널 또는 스레드에서 사용해 주세요.');
    return {guildId:i.guildId,threadId:i.channel.id,userId:i.user.id,isManager:i.memberPermissions?.has(i.channel.isThread()?PermissionFlagsBits.ManageThreads:PermissionFlagsBits.ManageChannels)??false};
  }
  // Viewing another member's boss records notifies that member.
  const bossNotice=(record,what)=>({owner:record.ownerId,name:record.characterName,what});
  // History shows one week at a time; by default the most recently saved week.
  function historyView(ctx,id,{selected,notice=null,page=0}={}) {
    const o=need(records,'보스 기록').weekOptions(ctx,id);
    return view.bossHistory(o,priceMap(ctx.guildId),{selected:selected===undefined?o.options.find(x=>x.saved)?.week??null:selected,canEdit:o.character.ownerId===ctx.userId,notice,page});
  }
  // A saved week is shown from the database; only an unsaved this/last week loads a preview.
  async function pickWeek(ctx,id,week) {
    const r=need(records,'보스 기록'),option=r.weekOptions(ctx,id).options.find(o=>o.week===week);
    requireRule(option,'선택할 수 없는 주차예요. 히스토리를 다시 열어 주세요.','NOT_FOUND');
    if(option.saved) return {payload:historyView(ctx,id,{selected:week}),notice:null};
    const result=await r.view(ctx,id,option.period);
    return {payload:view.bossRecord(result.record,priceMap(ctx.guildId),{fetched:result.fetched}),notice:result.fetched?bossNotice(result.record,`${view.weekLabel(result.record.week)} 보스 기록`):null};
  }
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
  async function imported(ctx,result) {
    const draft=connections.beginSelection(ctx,'add');
    const payload=view.characterSelection(await connections.loadSelectionPage(ctx,draft.id));
    return {...payload,content:`${result.cached?'최근 계정 목록을 사용해요.':'계정 목록을 갱신했어요.'} 새 캐릭터는 자동 등록하지 않아요.\n${payload.content}`};
  }
  function scheduler(ctx,id,index=0,page=0) {
    requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');
    return view.schedulerDetail(tracker.character(ctx,id,true),tracker.schedulerHistory(ctx,id),index,page);
  }
  // One stored-power lookup for the characters on the shown page; no API calls.
  function rosterView(ctx,s,page,owner,eligible=null) {
    const shown=view.paginate(s.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner)),page,10).items;
    return view.roster(s,page,owner,eligible,tracker?.latestPowers(ctx,shown.map(c=>c.id))??null);
  }
  async function pushedUp(i) {
    if(!i.message?.id) return false;
    try {
      const latest=await i.channel.messages.fetch({limit:1,cache:false});
      return [...latest.values()].some(message=>BigInt(message.id)>BigInt(i.message.id));
    } catch {console.warn('[panel] position-unavailable');return false;}
  }
  async function rememberPanel(i,message,deletedSource=null) {
    if(!message?.id) return;
    const now=Date.now();
    // Interaction tokens cannot delete ephemeral messages after 15 minutes.
    for(const [key,panel] of privatePanels) if(panel.expiresAt<=now) privatePanels.delete(key);
    const key=`${i.guildId}:${i.channel.id}:${i.user.id}`,previous=privatePanels.get(key);
    privatePanels.set(key,{id:message.id,expiresAt:(i.createdTimestamp??now)+15*60_000,remove:()=>i.deleteReply(message.id)});
    if(previous&&previous.id!==message.id&&previous.id!==deletedSource) await previous.remove().catch(()=>console.warn('[panel] previous-delete-failed'));
  }
  async function respond(i,payload,privateSource=false) {
    const response={content:null,embeds:[],components:[],allowedMentions:{parse:[]},...payload};
    if(!privateSource||!await pushedUp(i)) {
      const message=await i.editReply(response);
      await rememberPanel(i,message);
      return message;
    }
    // Keep the old panel until the new private message has been delivered.
    const message=await i.followUp({...response,flags:MessageFlags.Ephemeral});
    await i.deleteReply().catch(()=>console.warn('[panel] delete-failed'));
    await rememberPanel(i,message,i.message.id);
    return message;
  }
  async function getEligible(ctx,i,ids) {ctx.eligibleOwnerIds=await resolveOwners(i.channel,ids);return ctx;}
  async function detail(ctx,i,id) {
    const p=service.getParty(ctx,id,true),s=service.snapshot(ctx);
    await getEligible(ctx,i,p.characterIds.map(cid=>s.characters.find(c=>c.id===cid)?.ownerId).filter(Boolean));
    return view.partyDetail(s,p,ctx,service.warnings(s,p),prices?priceMap(ctx.guildId):null);
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
    if(!i.isChatInputCommand()&&!i.isButton()&&!i.isStringSelectMenu()&&!i.isModalSubmit()&&!i.isUserSelectMenu?.()) return;
    let changed=false,notice=null,publicPost=null;
    try {
      if(i.customId?.startsWith('sc:')&&scheduleUI&&await scheduleUI.modal(i,quickContext(i))) return;
      // Opening a blank modal reveals no saved data. Recheck live membership on submit.
      if(i.isButton()&&['mp:apikey','mp:create'].includes(i.customId)) {
        requireRule(i.inGuild()&&i.guildId===guildId&&supportedChannel(i.channel),'설정한 서버의 일반 채널 또는 스레드에서 사용해 주세요.');
        return await i.showModal(i.customId==='mp:apikey'?view.registrationModal():view.creationModal());
      }
      if(i.isUserSelectMenu?.()&&i.customId.startsWith('mp:distseller:')) {
        const pid=i.customId.split(':')[2],seller=i.values[0];
        need(distributions,'분배').requireSeller(quickContext(i),pid,seller);
        return await i.showModal(view.distModal(`mp:modal:dist:${pid}:${seller}`));
      }
      if(i.isButton()&&i.customId.startsWith('mp:distedit:')) {
        const record=need(distributions,'분배').get(quickContext(i),i.customId.split(':')[2]);
        requireRule(record.sellerId===i.user.id,'판매자로 지정된 사람만 수정할 수 있어요.','FORBIDDEN');
        return await i.showModal(view.distModal(`mp:modal:distedit:${record.id}`,record));
      }
      const privateSource=(i.isButton()||i.isStringSelectMenu()||i.isModalSubmit())&&i.message?.flags?.has(MessageFlags.Ephemeral);
      if(privateSource) await i.deferUpdate();
      else await i.deferReply({flags:MessageFlags.Ephemeral});
      const ctx=await verifyContext(i,guildId),rid=i.id;
      let payload;
      if((i.isChatInputCommand()&&i.commandName==='일정')||i.customId?.startsWith('sc:')) {
        requireRule(scheduleUI,'일정 기능을 사용할 수 없어요. 봇을 업데이트해 주세요.');
        const result=await scheduleUI.handle(i,ctx);payload=result.payload;changed=result.changed;
        if(changed&&scheduleWorker)await scheduleWorker.refresh(ctx);
        if(changed&&result.scheduleId&&schedules.deliveryIssues(ctx,result.scheduleId).length)payload.content=`${payload.content??'일정 변경은 저장됐어요.'}\n공개 카드 또는 알림 전송을 확인하지 못했어요. 관리 메뉴에서 발송 상태를 확인해 주세요.`;
      } else if(i.isChatInputCommand()) {
        const sub=i.options.getSubcommand(),get=n=>i.options.getString(n),pid=get('파티');
        if(i.commandName==='보스방') {
          if(sub==='시작') {service.start(ctx,rid);changed=true;}
          payload=view.board(service.snapshot(ctx),schedules?.list(ctx)??[]);
        } else if(i.commandName==='캐릭터') {
          if(sub==='연결'||sub==='등록') payload=connection(ctx);
          if(sub==='연결해제') payload=disconnect(ctx);
          if(sub==='동기화') {connection(ctx);payload=await imported(ctx,await connections.refresh(ctx));changed=true;onConnectionChanged();}
          if(sub==='스케줄러') payload=scheduler(ctx,get('캐릭터'));
          if(sub==='스케줄러갱신') {requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');const result=await tracker.syncScheduler(ctx,get('캐릭터'));payload=scheduler(ctx,get('캐릭터'));if(result.cached)payload.content='5분 이내 수집한 기록을 보여드려요.';}
          if(sub==='목록') {
            const owner=i.options.getUser('등록자')?.id??'all',s=service.snapshot(ctx);
            const shown=view.paginate(s.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner)),0,10).items;
            await getEligible(ctx,i,shown.map(c=>c.ownerId));payload=rosterView(ctx,s,0,owner,ctx.eligibleOwnerIds);
          }
          if(sub==='수정') {service.editCharacter(ctx,get('캐릭터'),{name:get('이름')??undefined},rid);changed=true;payload=rosterView(ctx,service.snapshot(ctx),0,ctx.userId);}
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
        } else if(i.commandName==='보스기록') {
          const r=need(records,'보스 기록'),id=get('캐릭터');
          if(sub==='히스토리') {const c=r.access(ctx,id);payload=historyView(ctx,id);notice={owner:c.ownerId,name:c.name,what:'보스 히스토리'};}
        } else if(i.commandName==='결정석') {
          const book=need(prices,'결정석 가격');
          if(sub==='가격표') payload=view.priceTable(book.all(ctx.guildId));
          if(sub==='가격수정') {const r=book.set(ctx,get('보스'),get('난이도'),get('가격'));payload={...view.priceTable(book.all(ctx.guildId)),content:`${r.difficulty} ${r.boss.name} 결정석 가격을 ${formatMeso(r.before)} → ${formatMeso(r.price)}(으)로 수정했어요.`};}
        } else if(i.commandName==='분배') {
          if(sub==='시작') payload=view.distQuestion(service.getParty(ctx,pid));
          if(sub==='목록') payload=view.distList(service.getParty(ctx,pid,true),need(distributions,'분배').list(ctx,pid),0);
        }
      } else if(i.isModalSubmit()) {
        if(i.customId==='mp:modal:register') payload=connection(ctx);
        if(i.customId==='mp:modal:apikey') {connection(ctx);payload=await imported(ctx,await connections.connect(ctx,i.fields.getTextInputValue('apikey')));changed=true;onConnectionChanged();}
        if(i.customId==='mp:modal:create') {const p=service.createParty(ctx,i.fields.getTextInputValue('name'),rid);changed=true;payload=await detail(ctx,i,p.id);}
        const [,,kind,id,seller]=i.customId.split(':');
        if(kind==='dist') {
          const book=need(distributions,'분배');book.requireSeller(ctx,id,seller);
          await getEligible(ctx,i,[seller]);requireRule(ctx.eligibleOwnerIds.has(seller),'판매자가 현재 채널/스레드 참가자가 아니에요.','NOT_MEMBER');
          const record=book.create(ctx,{partyId:id,sellerId:seller,item:i.fields.getTextInputValue('item'),price:i.fields.getTextInputValue('price')},rid);
          publicPost=view.distCard(record);payload={content:'분배금 계산 결과를 채널에 게시했어요.'};
        }
        if(kind==='distedit') {
          const record=need(distributions,'분배').update(ctx,id,{item:i.fields.getTextInputValue('item'),price:i.fields.getTextInputValue('price'),memberCount:i.fields.getTextInputValue('members')});
          payload=view.distCard(record);await editPublic(i,payload);payload.content='분배 기록을 수정하고 수정 로그를 저장했어요.';
        }
      } else {
        const [prefix,action,id,a,b]=i.customId.split(':');requireRule(prefix==='mp','지원하지 않는 동작이에요.');
        const selected=i.values?.[0];
        if(action==='register') payload=connection(ctx);
        if(action==='charadd'||action==='charremove') {connection(ctx);const draft=connections.beginSelection(ctx,action==='charadd'?'add':'remove');payload=view.characterSelection(await connections.loadSelectionPage(ctx,draft.id));}
        if(action==='charpage'||action==='charselect') {connection(ctx);const page=Number(a),draft=action==='charselect'?connections.selection(ctx,id,page,i.values):await connections.loadSelectionPage(ctx,id,page);payload=view.characterSelection(draft,page);}
        if(action==='charcomplete') {connection(ctx);const result=connections.completeSelection(ctx,id);changed=true;onConnectionChanged();payload={...connection(ctx),content:result.removed!==undefined?`내 캐릭터 ${result.removed}개를 삭제했어요. 과거 파티·기록은 유지하며 자동 수집을 중단해요.`:`등록 완료: 추가 ${result.added}개 · 갱신 ${result.updated}개 · 이름 충돌 ${result.conflicts}개. 등록한 캐릭터만 자동 수집해요.`};}
        if(action==='accountsync') {connection(ctx);payload=await imported(ctx,await connections.refresh(ctx));changed=true;onConnectionChanged();}
        if(action==='disconnectask') payload=disconnect(ctx);
        if(action==='disconnect') {connection(ctx);connections.disconnect(ctx,id);payload={...connection(ctx),content:'내 API 연결을 해제했어요. 키를 삭제하고 자동 추적을 중단했습니다. 기존 캐릭터·파티·기록은 유지됩니다.'};}
        if(action==='schedulerpicker') payload=view.schedulerPicker(service.snapshot(ctx),ctx.userId,Number(id));
        if(action==='scheduler'||action==='selectscheduler') payload=scheduler(ctx,selected??id,Number(a)||0,Number(b)||0);
        if(action==='schedulersync') {requireRule(tracker,'스케줄러 기능을 사용할 수 없어요.');const result=await tracker.syncScheduler(ctx,id);payload=scheduler(ctx,id);if(result.cached)payload.content='5분 이내 수집한 기록을 보여드려요.';}
        if(action==='specpicker') payload=view.specPicker(service.snapshot(ctx),Number(id));
        if(action==='selectspec'||action==='spec') payload=specs(ctx,selected??id,Number(a)||0,Number(b)||0);
        if(action==='specsync') {requireRule(tracker,'스펙 추적 기능을 사용할 수 없어요.');const result=await tracker.sync(ctx,id);changed=!result.cached;payload=specs(ctx,id);}
        if(action==='board') {payload=view.board(service.snapshot(ctx),schedules?.list(ctx)??[]);changed=true;}
        if(action==='roster') {
          const s=service.snapshot(ctx),page=Number(a),shown=view.paginate(s.characters.filter(c=>c.active&&(id==='all'||c.ownerId===id)),page,10).items;
          await getEligible(ctx,i,shown.map(c=>c.ownerId));payload=rosterView(ctx,s,page,id,ctx.eligibleOwnerIds);
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
        if(action==='bhrefresh'||action==='bhreload') {
          const r=need(records,'보스 기록'),period=a==='last'?'last':'current',result=await r.refresh(ctx,id,period),record=r.cached(ctx,id,period);
          requireRule(record,'해당 주차의 스케줄러 기록을 찾지 못했어요. 게임 접속 여부와 API 제공 상태를 확인해 주세요.','NEXON_NO_SCHEDULER');
          payload=view.bossRecord(record,priceMap(ctx.guildId),{fetched:!result.cached,refreshed:result.cached?'cached':'fetched'});
          if(!result.cached) notice=bossNotice(record,`${view.weekLabel(record.week)} 보스 기록`);
        }
        if(action==='bhpick'||action==='bhload') {
          // bhload: buttons on messages sent before the week dropdown existed.
          const r=need(records,'보스 기록'),week=action==='bhpick'?selected:r.weekOptions(ctx,id).options.find(o=>o.period===(a==='last'?'last':'current'))?.week;
          ({payload,notice}=await pickWeek(ctx,id,week));
        }
        if(action==='bhshow') payload=historyView(ctx,id,{selected:a});
        if(action==='bhquick') {
          const r=need(records,'보스 기록'),{record,fetched}=await r.saveLatest(ctx,id,a==='last'?'last':'current'),done=`${view.weekLabel(record.week)} 보스 기록을 저장했어요.`;
          if(record.ownerId===ctx.userId&&record.cleared.length) payload=view.bossWeekEditor(r.week(ctx,id,record.week),priceMap(ctx.guildId),`${done}\n함께 클리어한 인원을 고르면 결정석을 그 인원만큼 나눠요.`);
          else payload=historyView(ctx,id,{selected:record.week,notice:done});
          if(fetched) notice=bossNotice(record,`${view.weekLabel(record.week)} 보스 기록`);
        }
        if(action==='bhpicker') payload=view.bossHistoryPicker(need(records,'보스 기록').viewableCharacters(ctx),Number(id));
        if(action==='selectbh') {const c=need(records,'보스 기록').access(ctx,selected);payload=historyView(ctx,selected);notice={owner:c.ownerId,name:c.name,what:'보스 히스토리'};}
        // Saving leads straight to the party-size editor for the owner; others return to the history.
        if(action==='bhsave') {
          const r=need(records,'보스 기록'),record=r.save(ctx,id,a,Number(b)),done='보스 기록을 저장했어요. 같은 주차는 마지막으로 저장한 기록으로 바뀌어요.';
          if(record.ownerId===ctx.userId&&record.cleared.length) payload=view.bossWeekEditor(r.week(ctx,id,record.week),priceMap(ctx.guildId),`${done}\n함께 클리어한 인원을 고르면 결정석을 그 인원만큼 나눠요.`);
          else payload=historyView(ctx,id,{selected:record.week,notice:done});
        }
        if(action==='bhskip') payload=historyView(ctx,id,{notice:'저장하지 않았어요.'});
        if(action==='bhist') payload=historyView(ctx,id,{page:Number(a)||0});
        if(action==='bhweek'||action==='bhedit') {
          const w=need(records,'보스 기록').week(ctx,id,selected??a);
          requireRule(w.character.ownerId===ctx.userId,'캐릭터를 등록한 본인만 보스 기록을 편집할 수 있어요.','FORBIDDEN');
          payload=view.bossWeekEditor(w,priceMap(ctx.guildId));
        }
        if(action==='bhboss') {
          const w=need(records,'보스 기록').week(ctx,id,a);
          requireRule(w.character.ownerId===ctx.userId,'캐릭터를 등록한 본인만 보스 기록을 편집할 수 있어요.','FORBIDDEN');
          requireRule((w.week.rev??0)===Number(b),'그 사이 기록이 바뀌었어요. 히스토리를 다시 열어 주세요.','STALE');
          payload=view.partySizePicker(w,Number(selected),priceMap(ctx.guildId));
        }
        if(action==='bhsize') {
          const index=Number(i.customId.split(':')[5]),w=need(records,'보스 기록').setPartySize(ctx,id,a,Number(b),index,Number(selected)),entry=w.week.cleared[index];
          payload=view.bossWeekEditor(w,priceMap(ctx.guildId),`**${view.safe(entry.difficulty)} ${view.safe(entry.name)}**을(를) ${entry.partySize}인으로 바꿨어요.`);
        }
        if(action==='dist') payload=view.distQuestion(service.getParty(ctx,id));
        if(action==='distno') payload={content:'분배할 아이템이 없어 분배 계산을 진행하지 않았어요.',components:[view.backToParty(id)]};
        if(action==='distyes') payload=view.distSellerPicker(service.getParty(ctx,id));
        if(action==='distlist') payload=view.distList(service.getParty(ctx,id,true),need(distributions,'분배').list(ctx,id),Number(a));
        if(action==='distopen') payload=view.distCard(need(distributions,'분배').get(ctx,selected));
        if(action==='distmvp') {
          const book=need(distributions,'분배'),record=book.update(ctx,id,{mvp:!book.get(ctx,id).mvp});
          payload=view.distCard(record);await editPublic(i,payload);
        }
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
        await i.editReply({content:'조회한 내용을 채널에 게시합니다.',embeds:[],components:[],allowedMentions:{parse:[]}});
        if(i.commandName==='파티'&&i.options.getSubcommand()==='정보') payload=view.publicParty(payload,i.options.getString('파티'));
        await i.followUp({...payload,allowedMentions:{parse:[]}});
        await i.deleteReply();
      } else await respond(i,payload,privateSource);
      if(publicPost) await i.followUp({...publicPost,allowedMentions:{parse:[]}});
      if(notice&&notice.owner!==ctx.userId) await i.followUp({content:`<@${notice.owner}> <@${ctx.userId}>님이 **${view.safe(notice.name)}**의 ${notice.what}을 조회했어요.`,allowedMentions:{users:[notice.owner]}}).catch(()=>console.warn('[notice] send-failed'));
      if(changed) {
        if(scheduleWorker)await scheduleWorker.refresh(ctx);
        try {await refreshBoard(i,ctx);} catch(error) {
          console.warn('[board-refresh]',error.code??error.name);
          await i.followUp({content:'저장은 완료했지만 공용 관리판을 갱신하지 못했어요. 봇의 채널 권한을 확인하고 /보스방 시작을 다시 실행해 주세요.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}}).catch(()=>{});
        }
      }
    } catch(error) {
      console.warn('[interaction]',error.code??error.name);
      const payload={content:visibleError(error),embeds:[],components:[],allowedMentions:{parse:[]}};
      try {if(i.deferred||i.replied) await respond(i,payload);else await i.reply({...payload,flags:MessageFlags.Ephemeral});} catch { console.warn('[reply] response-unavailable'); }
      // Persisted mutations remain valid even if rendering or Discord delivery failed.
      if(changed) {
        try {const ctx=await verifyContext(i,guildId);await refreshBoard(i,ctx);} catch {console.warn('[board-refresh] retry-later');}
      }
    }
  };
}
