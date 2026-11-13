import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { scheduleDate } from './schedule.js';
import { bossById } from './catalog.js';
const safe=s=>escapeMarkdown(String(s??'')).replace(/@/g,'＠');
const row=(...v)=>new ActionRowBuilder().addComponents(...v);
const btn=(id,label,style=ButtonStyle.Secondary,disabled=false)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const embed=()=>new EmbedBuilder().setColor(0x46745b);
const names=(s,states)=>s.members.filter(m=>states.includes(s.responses[m.userId]?.state??'missing')).map(m=>safe(m.name)).join(', ').slice(0,550)||'-';
const home=()=>row(btn('sc:list:0','일정 목록'),btn('sc:mine:0','내 일정'));
const bossNames=bosses=>bosses.map(b=>`${safe(b.difficulty)} ${safe(bossById(b.bossId)?.name??b.bossId)}`).join(' / ').slice(0,650)||'보스 없음';
export const scheduleSummary=s=>`${scheduleDate(s.startAt)} · ${s.partyName}${s.status==='poll'?' (시간 투표)':s.status==='review'?' (검토 필요)':''}`;
export function scheduleCard(s,book,now=book.now()) {
  const ended=['elapsed','cancelled'].includes(s.status)||s.endAt<=now;
  const state=s.status==='cancelled'?'취소됨':ended?'지난 일정':s.status==='poll'?'시간 투표':s.startAt<=now?'출발 시각 지남':s.status==='review'?'검토 필요':'시간 확정';
  const yes=s.members.filter(m=>['yes','regular'].includes(s.responses[m.userId]?.state)).length;
  const lines=[`${scheduleDate(s.startAt)} ~ ${scheduleDate(s.endAt)} (한국 시간)`,bossNames(s.bosses),''];
  if(s.status==='poll') {
    const tally=book.tally(s),rank=[...tally].sort((a,b)=>a.no-b.no||b.yes-a.yes||a.at-b.at),best=rank[0]?.yes>0?rank[0].id:null;
    for(const [i,c] of tally.entries())lines.push(`${i+1}. ${scheduleDate(c.at)} · 가능 ${c.yes} / 불가 ${c.no} / 미응답 ${c.missing}${best===c.id?' · 추천':''}`);
    lines.push(`마감: ${scheduleDate(s.deadline)}${s.deadline<=now?' · 마감됨 (파티장 확정 대기)':''}`);
  } else {
    lines.push(`**${state} · 참석 ${yes}/${s.members.length}명**`,`참석: ${names(s,['yes'])}`,`정기 참석: ${names(s,['regular'])}`,`불참: ${names(s,['no'])}`,`미정: ${names(s,['maybe'])}`,`미응답: ${names(s,['missing'])}`);
    if(s.members.some(m=>s.responses[m.userId]?.state==='recheck'))lines.push(`재확인 필요: ${names(s,['recheck'])}`);
  }
  if(s.compositionChanged)lines.push('⚠️ 파티 구성 변경 확인 필요');
  if(s.conflictsAccepted)lines.push('⚠️ 겹치는 일정을 확인한 뒤 확정했어요.');
  if(s.note)lines.push(`메모: ${safe(s.note)}`);
  lines.push(s.reminder?`출발 ${s.reminder}분 전 알림`:'출발 알림 꺼짐');
  const emb=embed().setTitle(`${safe(s.partyName).slice(0,150)} · ${state}`).setDescription(lines.join('\n').slice(0,4000)).setFooter({text:s.seriesId?'정기 일정 · 정기 참석은 본인이 동의한 경우에만 유지돼요.':'일회성 일정 · 참석 응답은 시작 전까지 변경할 수 있어요.'});
  let controls;
  if(ended||s.startAt<=now)controls=row(btn('sc:mine:0','내 다음 일정'),btn(`sc:open:${s.id}`,'이력 보기'));
  else if(s.status==='poll')controls=row(btn(`sc:vote:${s.id}:${s.version}`,'투표하기',ButtonStyle.Primary,s.deadline<=now),btn('sc:mine:0','내 일정'),btn(`sc:manage:${s.id}`,'관리'));
  else controls=row(btn(`sc:attend:${s.id}:${s.version}:yes`,'참석',ButtonStyle.Success,s.status!=='confirmed'),btn(`sc:attend:${s.id}:${s.version}:no`,'이번엔 불참',ButtonStyle.Danger,s.status!=='confirmed'),btn(`sc:attend:${s.id}:${s.version}:maybe`,'미정',ButtonStyle.Secondary,s.status!=='confirmed'),btn(`sc:personal:${s.id}`,'내 일정'),btn(`sc:manage:${s.id}`,'관리'));
  return {embeds:[emb],components:[controls],allowedMentions:{parse:[]}};
}
export function scheduleList(items,{mine=false,page=0,offset=0,past=false,partyId=null}={}) {
  const pages=Math.max(1,Math.ceil(items.length/8)),p=Math.max(0,Math.min(Number(page)||0,pages-1)),shown=items.slice(p*8,p*8+8);
  const prefix=mine?'mine':'list';
  const nav=(page,off,old=false,control='')=>(partyId?`sc:plist:${partyId}:${page}:${off}:${old?'past':''}`:`sc:${prefix}:${page}:${off}:${old?'past':''}`)+`:${control}`;
  const emb=embed().setTitle(past?'지난 일정':mine?'내 일정':'보스 일정').setDescription(shown.map(s=>`**${safe(s.partyName)}**\n${safe(scheduleSummary(s))}${mine?` · 내 응답: ${safe(({yes:'참석',regular:'정기 참석',no:'불참',maybe:'미정',recheck:'재확인 필요'})[s.myState]??'미응답')}`:''}`).join('\n\n').slice(0,3900)||'이 기간에 등록된 일정이 없어요.').setFooter({text:`현재 채널 · ${past?'지난 회차':`${offset?`다음 ${offset}~${offset+7}일`:'앞으로 7일'}`} · ${p+1}/${pages} 페이지`});
  const controls=[];
  if(shown.length)controls.push(row(new StringSelectMenuBuilder().setCustomId('sc:choose').setPlaceholder('일정 열기').addOptions(shown.map(s=>({label:scheduleSummary(s).slice(0,100),value:s.id})))));
  controls.push(row(btn(nav(p-1,offset,past,'prev'),'이전 목록',ButtonStyle.Secondary,p===0),btn(nav(p+1,offset,past,'next'),'다음 목록',ButtonStyle.Secondary,p>=pages-1)));
  controls.push(row(btn(nav(0,Math.max(0,offset-7),false,'back'),'앞 7일',ButtonStyle.Secondary,offset===0),btn(nav(0,offset+7,false,'forward'),'다음 7일',ButtonStyle.Secondary,offset>=77),btn(nav(0,0,true,'history'),'지난 일정')));
  controls.push(home());return {embeds:[emb],components:controls,allowedMentions:{parse:[]}};
}
export function scheduleStart(p) {const ready=p.characterIds.length>0&&p.bosses.length>0;return {content:`**${safe(p.name)}** · ${ready?'일정을 어떻게 잡을까요?':'파티 정보에서 캐릭터와 보스를 먼저 등록해 주세요.'}`,embeds:[],components:[row(btn(`sc:new:${p.id}:fixed`,'시간 바로 등록',ButtonStyle.Primary,!ready),btn(`sc:new:${p.id}:poll`,'후보 시간 투표',ButtonStyle.Secondary,!ready),btn(`sc:plist:${p.id}:0:0`,'이 파티 일정 보기')),row(btn(`mp:detail:${p.id}`,'파티 정보')),home()],allowedMentions:{parse:[]}};}
function field(id,label,value='',paragraph=false,required=true,max=200) {const f=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(paragraph?TextInputStyle.Paragraph:TextInputStyle.Short).setRequired(required).setMaxLength(max);if(value)f.setValue(value);return row(f);}
export function scheduleInputModal(partyId,mode,initial='',duration=60) {
  return new ModalBuilder().setCustomId(`sc:modal:create:${partyId}:${mode}`).setTitle(mode==='poll'?'출발 후보 시간 입력':'보스 출발 시간 입력').addComponents(field('time',mode==='poll'?'후보 2~5줄 (예: 토 22:00)':'출발 시간 (예: 오늘 22:00)',initial,mode==='poll'),field('duration','예상 소요 시간 (분)',String(duration),false,false,3));
}
export function schedulePreview(d,p,conflicts=[],members=[]) {
  const lines=[d.mode==='poll'?'후보 시간':`출발: ${scheduleDate(d.startAt)}`];if(d.mode==='poll')for(const c of d.candidates)lines.push(`• ${scheduleDate(c.at)}`);
  lines.push(`소요 ${d.duration}분 · ${d.repeat?'매주 반복':'이번 한 번'} · ${d.reminder?`${d.reminder}분 전 알림`:'알림 꺼짐'}`,bossNames(d.bosses));
  if(members.length)lines.push(`대상 ${members.length}명: ${members.map(m=>safe(m.name)).join(', ').slice(0,550)}`);
  if(d.repeat&&d.bosses.some(b=>bossById(b.bossId)?.monthly))lines.push('월간 보스가 포함돼 있어요. 매주 출발 일정이 입장·보상 가능 여부를 보장하지 않아요.');
  if(conflicts.length)lines.push(`⚠️ 겹치는 일정 ${conflicts.length}개`,...conflicts.slice(0,5).map(c=>`${safe(c.partyName)} · ${scheduleDate(c.startAt)}`));
  if(d.reason)lines.push(`확인 사유: ${safe(d.reason)}`);
  return {content:'날짜·요일과 인원·보스를 확인한 뒤 게시하세요.',embeds:[embed().setTitle(`${safe(p.name)} · 일정 미리보기`).setDescription(lines.join('\n').slice(0,3900))],components:[row(btn(`sc:post:${d.id}`,'게시',ButtonStyle.Primary),btn(`sc:draftrepeat:${d.id}`,d.repeat?'매주 반복 중':'이번 한 번'),btn(`sc:draftreminder:${d.id}`,'알림 변경'),btn(`sc:draftbosses:${d.id}`,'보스 선택')),row(btn(`sc:draftreason:${d.id}`,'충돌 확인 사유'),btn(`sc:new:${p.id}:${d.mode}`,'시간 다시 입력')),home()],allowedMentions:{parse:[]}};
}
export function scheduleBossPicker(d,p) {return {content:'이번 일정에서 갈 보스를 선택하세요.',embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`sc:setbosses:${d.id}`).setMinValues(1).setMaxValues(p.bosses.length).addOptions(p.bosses.map(b=>({label:`${b.difficulty} ${bossById(b.bossId)?.name??b.bossId}`.slice(0,100),value:b.bossId,default:d.bosses.some(x=>x.bossId===b.bossId)}))))]};}
export function scheduleVote(s,userId) {
  const old=s.votes[userId]?.values??[];
  return {content:'가능한 시간을 모두 선택하면 바로 저장돼요. 선택하지 않은 후보는 불가로 저장합니다.',embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`sc:savevote:${s.id}:${s.version}`).setPlaceholder('가능한 시간을 선택해 저장').setMinValues(0).setMaxValues(s.candidates.length).addOptions(s.candidates.map(c=>({label:scheduleDate(c.at),value:c.id,default:old.includes(c.id)})))),row(btn(`sc:allvote:${s.id}:${s.version}:yes`,'전부 가능',ButtonStyle.Success),btn(`sc:allvote:${s.id}:${s.version}:no`,'전부 불가',ButtonStyle.Danger)),row(btn(`sc:open:${s.id}`,'일정으로 돌아가기'))],allowedMentions:{parse:[]}};
}
export function schedulePersonal(s,ctx,book={now:()=>Date.now(),tally:()=>[]}) {
  return {...scheduleCard(s,book),content:s.exception?'이번 회차만 변경된 시간이에요. 정기 참석 동의는 원래 시간의 회차에서 설정해 주세요.':'참석 버튼은 이번 회차만 적용됩니다. 정기 참석은 아래에서 직접 동의하거나 해제하세요.',components:[row(btn(`sc:regular:${s.id}:${s.version}:on`,'매주 이 시간 참석',ButtonStyle.Success,!s.seriesId||s.status!=='confirmed'||Boolean(s.exception)),btn(`sc:regular:${s.id}:${s.version}:off`,'정기 참석 해제',ButtonStyle.Secondary,!s.seriesId),btn(`sc:open:${s.id}`,'일정 보기'))]};
}
export function scheduleManage(s,p,ctx,issues=[]) {
  const can=p.creatorId===ctx.userId||ctx.isManager;if(!can)return {content:'일정 관리는 파티 생성자 또는 채널/스레드 관리자가 할 수 있어요.',components:[row(btn(`sc:personal:${s.id}`,'내 응답 설정'))]};
  const options=[...(s.status==='poll'?[]:[{label:'시간 변경 · 이번 회차만',value:'edit'}]),{label:'시간 다시 투표',value:'repoll'},{label:'현재 파티 구성 적용',value:'composition'},{label:'미응답자에게 알림',value:'nudge'},{label:'이번 회차 취소',value:'cancel'},{label:'공개 카드 다시 게시',value:'repost'}];
  if(s.status==='poll'||s.status==='review')options.unshift({label:'시간 확정',value:'confirm'});
  if(s.seriesId){if(s.status!=='poll')options.push({label:'이번 회차와 이후 시간 변경',value:'editfuture'});options.push({label:'이번 회차와 이후 중단',value:'stop'});}
  if(issues.length)options.push({label:'실패·미확인 알림 다시 보내기',value:'retry'});
  return {content:`**${safe(s.partyName)}** · 관리할 항목을 선택하세요.${issues.length?`\n⚠️ ${issues.map(i=>safe(i.error)).join('\n')}`:''}`,embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`sc:operation:${s.id}:${s.version}`).addOptions(options)),row(btn(`sc:open:${s.id}`,'일정 보기'))],allowedMentions:{parse:[]}};
}
export function scheduleRetry(s) {return {content:'전송 결과가 불명확한 알림은 이미 도착했을 수도 있어요. 중복 안내 가능성을 확인한 뒤 다시 보낼까요?',embeds:[],components:[row(btn(`sc:retry:${s.id}:${s.version}`,'확인 후 다시 보내기',ButtonStyle.Primary),btn(`sc:manage:${s.id}`,'돌아가기'))]};}
export function scheduleConfirmPicker(s,book) {
  if(s.status==='review')return {content:'겹치는 일정과 인원을 확인한 뒤 확정하세요.',components:[row(btn(`sc:confirmmodal:${s.id}:${s.version}:review`,'확인 사유 입력 후 확정',ButtonStyle.Primary))]};
  const candidates=book.tally(s).filter(c=>c.at>book.now());
  if(!candidates.length)return {content:'모든 후보의 출발 시각이 지났어요. 새 시간으로 일정을 다시 잡아 주세요.',components:[row(btn(`sc:start:${s.partyId}`,'일정 다시 잡기'))]};
  return {content:'확정할 시간을 선택하세요. 불가·미응답 인원과 시간 충돌이 있으면 사유를 입력합니다.',embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`sc:pickconfirm:${s.id}:${s.version}`).addOptions(candidates.map(c=>({label:scheduleDate(c.at),description:`가능 ${c.yes} · 불가 ${c.no} · 미응답 ${c.missing}`,value:c.id}))))]};
}
export function scheduleReasonModal(kind,id,version='',candidate='') {return new ModalBuilder().setCustomId(`sc:modal:${kind}:${id}:${version}:${candidate}`).setTitle('확인 사유').addComponents(field('reason','불참·미응답·겹치는 일정을 어떻게 조정했나요?'));}
export function scheduleEditModal(s,future=false,poll=false) {return new ModalBuilder().setCustomId(`sc:modal:${poll?'repoll':future?'editfuture':'edit'}:${s.id}:${s.version}`).setTitle(poll?'후보 다시 제안':future?'이번 회차와 이후 시간 변경':'이번 회차 시간 변경').addComponents(field('time',poll?'후보 2~5줄 (예: 토 22:00)':'출발 시간 (예: 토 22:00)',new Date(s.startAt+9*3600_000).toISOString().slice(0,16).replace('T',' '),poll),field('duration','예상 소요 시간 (분)',String(s.duration),false,true,3));}
export function scheduleCancel(s,future,count=1) {return {content:future?`이번 회차와 이후의 미진행 회차 ${count}개를 취소하고 반복을 중단할까요?`:'이번 회차만 취소할까요? 다음 주 일정은 유지됩니다.',embeds:[],components:[row(btn(`sc:cancel:${s.id}:${s.version}:${future?'future':'one'}`,'확인 후 취소',ButtonStyle.Danger),btn(`sc:open:${s.id}`,'돌아가기'))]};}
