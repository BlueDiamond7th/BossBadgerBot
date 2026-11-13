import { requireRule } from './errors.js';
import { requireEditable } from './access.js';
import * as ui from './schedule-views.js';

export function createScheduleInteractions({schedules,resolveOwners}) {
  const book=schedules;
  async function validateMembers(i,ctx,members) {
    const eligible=await resolveOwners(i.channel,members.map(m=>m.userId));requireRule(members.every(m=>eligible.has(m.userId)),'현재 채널/스레드에 참가하지 않는 파티원이 있어요. 파티 구성을 확인해 주세요.');
  }
  function preview(ctx,d) {const p=book.party(ctx,d.partyId),members=book.members(ctx,p);return ui.schedulePreview(d,p,book.conflicts(ctx,{...d,members}),members);}
  return {
    async modal(i,ctx) {
      if(!i.customId?.startsWith('sc:'))return false;
      const [,action,id,version,extra]=i.customId.split(':');
      if(action==='new'&&i.isButton()) {const p=book.party(ctx,id);requireEditable(ctx,p);book.members(ctx,p);requireRule(p.bosses.length,'파티에 보스를 먼저 등록해 주세요.');await i.showModal(ui.scheduleInputModal(id,version,'',book.lastDuration(ctx,id)));return true;}
      if(action==='draftreason'&&i.isButton()) {const d=book.draft(ctx,id);requireEditable(ctx,book.party(ctx,d.partyId));await i.showModal(ui.scheduleReasonModal('draftreason',id));return true;}
      if((action==='pickconfirm'&&i.isStringSelectMenu())||(action==='confirmmodal'&&i.isButton())) {
        const s=book.get(ctx,id);book.manager(ctx,s);
        const candidate=s.candidates.find(c=>c.id===i.values?.[0]);
        if(candidate&&book.tally(s).find(c=>c.id===candidate.id)?.yes===s.members.length&&!book.conflicts(ctx,{...s,startAt:candidate.at,endAt:candidate.at+s.duration*60_000}).length)return false;
        await i.showModal(ui.scheduleReasonModal('confirm',id,version,i.values?.[0]??extra));return true;
      }
      if(action==='operation'&&i.isStringSelectMenu()&&['edit','editfuture','repoll'].includes(i.values?.[0])) {
        const s=book.get(ctx,id);book.manager(ctx,s);await i.showModal(ui.scheduleEditModal(s,i.values[0]==='editfuture',i.values[0]==='repoll'));return true;
      }
      return false;
    },
    async handle(i,ctx) {
      let payload,changed=false,scheduleId=null;
      if(i.isChatInputCommand()) {
        const sub=i.options.getSubcommand();
        if(sub==='생성')payload=ui.scheduleStart(book.party(ctx,i.options.getString('파티')));
        else {const mine=sub==='내일정',items=book.list(ctx,{mine});for(const s of items)s.myState=s.responses[ctx.userId]?.state;payload=ui.scheduleList(items,{mine});}
      } else if(i.isModalSubmit()) {
        const [,,kind,id,version,extra]=i.customId.split(':');
        if(kind==='create') {const options=book.parseInput(version,i.fields.getTextInputValue('time'),i.fields.getTextInputValue('duration'));const d=book.makeDraft(ctx,id,options,i.id);payload=preview(ctx,d);}
        if(kind==='draftreason')payload=preview(ctx,book.changeDraft(ctx,id,{reason:i.fields.getTextInputValue('reason')},i.id));
        if(kind==='confirm') {await validateMembers(i,ctx,book.get(ctx,id).members);const s=book.confirm(ctx,id,extra,version,i.fields.getTextInputValue('reason'),i.id);payload=ui.scheduleCard(s,book);changed=true;}
        if(['edit','editfuture','repoll'].includes(kind)) {const options=book.parseInput(kind==='repoll'?'poll':'fixed',i.fields.getTextInputValue('time'),i.fields.getTextInputValue('duration'));if(kind!=='repoll')delete options.candidates;const s=book.edit(ctx,id,version,{...options,future:kind==='editfuture'},i.id);payload=ui.scheduleCard(s,book);changed=true;}
      } else {
        const [,action,id,version,extra]=i.customId.split(':');
        if(action==='start')payload=ui.scheduleStart(book.party(ctx,id));
        if(action==='plist') {const offset=Number(extra)||0,past=i.customId.split(':')[5]==='past';payload=ui.scheduleList(book.list(ctx,{partyId:id,offset,past}),{partyId:id,page:Number(version)||0,offset,past});}
        if(action==='list'||action==='mine') {const mine=action==='mine',offset=Number(version)||0,past=extra==='past',items=book.list(ctx,{mine,offset,past});for(const s of items)s.myState=s.responses[ctx.userId]?.state;payload=ui.scheduleList(items,{mine,page:Number(id)||0,offset,past});}
        if(action==='choose'||action==='open')payload=ui.scheduleCard(book.get(ctx,action==='choose'?i.values[0]:id),book);
        if(action==='pickconfirm') {await validateMembers(i,ctx,book.get(ctx,id).members);const s=book.confirm(ctx,id,i.values[0],version,'',i.id);payload=ui.scheduleCard(s,book);changed=true;}
        if(action==='draftrepeat') {const d=book.draft(ctx,id);payload=preview(ctx,book.changeDraft(ctx,id,{repeat:!d.repeat},i.id));}
        if(action==='draftreminder') {const d=book.draft(ctx,id);payload=preview(ctx,book.changeDraft(ctx,id,{reminder:d.reminder===10?30:d.reminder===30?0:10},i.id));}
        if(action==='draftbosses') {const d=book.draft(ctx,id);payload=ui.scheduleBossPicker(d,book.party(ctx,d.partyId));}
        if(action==='setbosses') {const d=book.draft(ctx,id),p=book.party(ctx,d.partyId),selected=i.values;requireRule(selected.length&&selected.every(id=>p.bosses.some(b=>b.bossId===id)),'파티에 등록된 보스를 선택해 주세요.');payload=preview(ctx,book.changeDraft(ctx,id,{bosses:p.bosses.filter(b=>selected.includes(b.bossId))},i.id));}
        if(action==='post') {const d=book.draft(ctx,id);await validateMembers(i,ctx,book.members(ctx,book.party(ctx,d.partyId)));const s=book.create(ctx,id,i.id);scheduleId=s.id;payload={content:'일정을 저장했어요. 채널의 공개 카드에서 응답할 수 있어요.',components:ui.scheduleCard(s,book).components};changed=true;}
        if(action==='attend') {book.respond(ctx,id,extra,version,i.id);payload={content:`${({yes:'참석',no:'이번 회차 불참',maybe:'미정'})[extra]}으로 저장했어요. 공개 카드에서 언제든 다시 바꿀 수 있어요.`};changed=true;}
        if(action==='vote') {const s=book._open(ctx,id,version);book._member(ctx,s);payload=ui.scheduleVote(s,ctx.userId);}
        if(action==='savevote'||action==='allvote') {const s=book.get(ctx,id),values=action==='savevote'?i.values:extra==='yes'?s.candidates.map(c=>c.id):[];book.vote(ctx,id,values,version,i.id);payload={content:'가능 시간을 저장했어요.',components:ui.scheduleCard(book.get(ctx,id),book).components};changed=true;}
        if(action==='personal')payload=ui.schedulePersonal(book.get(ctx,id),ctx,book);
        if(action==='regular') {const s=book.regular(ctx,id,extra==='on',version,i.id);payload={...ui.schedulePersonal(s,ctx,book),content:extra==='on'?'이 반복 시간에 정기 참석으로 동의했어요. 이번 주 불참은 별도로 바꿀 수 있어요.':'정기 참석을 해제했어요. 앞으로는 회차마다 응답해 주세요.'};changed=true;}
        if(action==='manage') {const s=book.get(ctx,id);payload=ui.scheduleManage(s,book.partyService.getParty(ctx,s.partyId,true),ctx,book.deliveryIssues(ctx,id));}
        if(action==='operation') {
          const s=book.get(ctx,id),op=i.values[0];book.manager(ctx,s);requireRule(s.version===Number(version),'일정 조건이 변경됐어요. 최신 관리 화면을 열어 주세요.','STALE');
          if(op==='confirm')payload=ui.scheduleConfirmPicker(s,book);
          if(op==='cancel'||op==='stop')payload=ui.scheduleCancel(s,op==='stop',book.upcomingCount(ctx,id));
          if(op==='composition') {await validateMembers(i,ctx,book.members(ctx,book.party(ctx,s.partyId)));payload=ui.scheduleCard(book.applyParty(ctx,id,version,i.id),book);changed=true;}
          if(op==='nudge'){book.nudge(ctx,id,i.id);payload={content:'미응답자 안내를 예약했어요.'};changed=true;}
          if(op==='repost'){book.repost(ctx,id,i.id);payload={content:'공개 카드 재게시를 예약했어요.'};changed=true;}
          if(op==='retry')payload=ui.scheduleRetry(s);
        }
        if(action==='cancel'){payload=ui.scheduleCard(book.cancel(ctx,id,version,extra==='future',i.id),book);changed=true;}
        if(action==='retry'){book.retryDelivery(ctx,id,version,i.id);payload={content:'알림 재전송을 예약했어요.'};changed=true;}
      }
      if(changed&&!scheduleId){const parts=i.customId.split(':');scheduleId=parts[1]==='modal'?parts[3]:parts[2];}
      requireRule(payload,'지원하지 않는 일정 동작이에요. 최신 화면을 다시 열어 주세요.');return {payload,changed,scheduleId};
    },
  };
}
