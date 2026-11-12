import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { specChanges } from './specs.js';
import { BOSSES, bossById } from './catalog.js';

export const safe=value=>escapeMarkdown(String(value)).replace(/@/g,'＠');
export const button=(id,label,style=ButtonStyle.Secondary,disabled=false)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row=(...items)=>new ActionRowBuilder().addComponents(...items);
const home=()=>row(button('mp:board','보스방'),button('mp:roster:all:0','캐릭터'),button('mp:parties:active:0','파티'));
const base=()=>new EmbedBuilder().setColor(0x46745b);
const truncate=(s,max=100)=>String(s).slice(0,max);
export function paginate(items,page=0,size=15) {
  const pages=Math.max(1,Math.ceil(items.length/size));
  const current=Math.max(0,Math.min(Number.isSafeInteger(page)?page:0,pages-1));
  return {items:items.slice(current*size,(current+1)*size),page:current,pages,total:items.length};
}
const pager=(prefix,page,pages)=>row(button(`${prefix}:${page-1}`,'이전',ButtonStyle.Secondary,page===0),button(`${prefix}:${page+1}`,'다음',ButtonStyle.Secondary,page>=pages-1));
export function board(state) {
  const count=state.characters.filter(c=>c.active).length, parties=state.parties.filter(p=>!p.archived);
  return {embeds:[base().setTitle('🍁 우리들의 보스방').setDescription('내 API 키로 캐릭터를 불러오고, 목록에서 골라 파티를 만들어 보세요.\n이 채널 또는 스레드 안에서 여러 파티와 파티별 보스를 관리해요.').addFields(
    {name:'등록 캐릭터',value:`${count}개`,inline:true},{name:'활성 파티',value:`${parties.length}개`,inline:true},
    {name:'파티 미리보기',value:parties.slice(0,6).map(p=>`• ${safe(p.name)} · ${p.characterIds.length}명 · 보스 ${p.bosses.length}개`).join('\n')||'아직 파티가 없어요. 파티 만들기부터 시작하세요.'}
  ).setFooter({text:'캐릭터 수 제한 없음 · API 연결은 본인만 · 편성은 파티 생성자/관리자'})],components:[row(button('mp:register','내 API 키 연결',ButtonStyle.Primary),button('mp:roster:all:0','캐릭터 목록'),button('mp:create','파티 만들기',ButtonStyle.Primary)),row(button('mp:parties:active:0','파티 목록'),button('mp:parties:archived:0','보관함'),button('mp:board','새로고침'))],allowedMentions:{parse:[]}};
}
export function roster(state,page=0,owner='all',eligibleOwnerIds=null) {
  const chars=state.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner));const view=paginate(chars,page,10);
  const lines=view.items.map(c=>`**${safe(c.name)}** · ${safe(c.world??'월드 미확인')} / ${safe(c.job??'직업 미확인')}\n등록자 <@${c.ownerId}>${eligibleOwnerIds&&!eligibleOwnerIds.has(c.ownerId)?' · ⚠️ 현재 참가자 아님':''}`);
  return {embeds:[base().setTitle('보스방 캐릭터 목록').setDescription(lines.join('\n\n')||'등록된 캐릭터가 없어요. 내 API 키 연결을 눌러 주세요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 총 ${view.total}개 · 기존 수동 등록과 API로 불러온 캐릭터가 함께 표시돼요.`})],components:[pager(`mp:roster:${owner}`,view.page,view.pages),row(button('mp:register','내 API 키 연결',ButtonStyle.Primary),button('mp:specpicker:0','스펙 변화'),button('mp:schedulerpicker:0','내 스케줄러')),home()],allowedMentions:{parse:[]}};
}
export function partyList(state,page=0,archived=false) {
  const view=paginate(state.parties.filter(p=>p.archived===archived),page);
  const components=[];
  if(view.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId('mp:open').setPlaceholder('파티 선택').addOptions(view.items.map(p=>({label:truncate(p.name),value:p.id,description:`캐릭터 ${p.characterIds.length}명 · 보스 ${p.bosses.length}개`})) )));
  components.push(pager(`mp:parties:${archived?'archived':'active'}`,view.page,view.pages));
  if(!archived) components.push(row(button('mp:create','파티 만들기',ButtonStyle.Primary)));
  components.push(home());
  return {embeds:[base().setTitle(archived?'파티 보관함':'우리 보스방의 파티').setDescription(view.items.map(p=>`**${safe(p.name)}**\n${p.characterIds.length}명 · 보스 ${p.bosses.length}개 · 만든 사람 <@${p.creatorId}>`).join('\n\n')||'아직 파티가 없어요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 총 ${view.total}개`})],components,allowedMentions:{parse:[]}};
}
export function partyDetail(state,p,ctx,warnings=[]) {
  const chars=p.characterIds.map(id=>state.characters.find(c=>c.id===id)).filter(Boolean);
  const canEdit=ctx.isManager||p.creatorId===ctx.userId;
  const emb=base().setTitle(`${p.archived?'📦':'⚔️'} ${safe(p.name)}`).setDescription(`만든 사람 <@${p.creatorId}> · ${chars.length}명${p.archived?' · 보관됨':''}`).addFields(
    {name:'파티 캐릭터',value:chars.slice(0,12).map(c=>`• **${safe(c.name)}** · ${safe(c.job??'직업 미확인')} · <@${c.ownerId}>${ctx.eligibleOwnerIds&&!ctx.eligibleOwnerIds.has(c.ownerId)?' ⚠️ 현재 참가자 아님':''}`).join('\n').slice(0,1000)||'아직 비어 있어요. 아래에서 캐릭터를 추가하세요.'},
    {name:'등록 보스',value:p.bosses.map((b,i)=>`${i+1}. ${safe(b.difficulty)} ${safe(bossById(b.bossId)?.name??b.bossId)}`).join('\n')||'보스가 아직 등록되지 않았어요.'}
  ).setFooter({text:`구성 버전 ${p.version} · 캐릭터·보스 변경은 이 파티에만 반영돼요.`});
  if(chars.length>12) emb.addFields({name:'전체 구성원',value:`총 ${chars.length}명 중 12명을 표시했어요. 캐릭터 목록이나 제외 메뉴에서 나머지를 확인하세요.`});
  if(warnings.length) emb.addFields({name:'편성 확인',value:warnings.slice(0,3).map(safe).join('\n').slice(0,1000)});
  const components=[];const token=`${p.id}:0:${p.version}`;
  if(canEdit&&!p.archived) components.push(row(button(`mp:addmember:${token}`,'캐릭터 추가',ButtonStyle.Primary),button(`mp:delmember:${token}`,'캐릭터 제외'),button(`mp:addboss:${token}`,'보스 추가',ButtonStyle.Primary),button(`mp:delboss:${token}`,'보스 제외')));
  const secondary=[button(`mp:copy:${p.id}`,'구성 복사')];
  if(canEdit) secondary.push(button(`mp:archive:${p.id}:${p.version}:${p.archived?'restore':'store'}`,p.archived?'복원':'보관'));
  secondary.push(button(`mp:detail:${p.id}`,'새로고침'));
  components.push(row(...secondary),home());
  return {embeds:[emb],components,allowedMentions:{parse:[]}};
}
export function memberPicker(state,p,page=0,remove=false,eligibleOwnerIds=null) {
  const ownerIds=new Set(p.characterIds.map(id=>state.characters.find(c=>c.id===id)?.ownerId));
  const chars=state.characters.filter(c=>remove?p.characterIds.includes(c.id):c.active&&!ownerIds.has(c.ownerId)&&(!eligibleOwnerIds||eligibleOwnerIds.has(c.ownerId)));
  const view=paginate(chars,page,20);const action=remove?'delmember':'addmember';const components=[];
  if(view.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`mp:${remove?'removemember':'selectmember'}:${p.id}:${p.version}`).setPlaceholder(remove?'제외할 캐릭터':'추가할 캐릭터').addOptions(view.items.map(c=>({label:truncate(`${c.name} · ${c.world??'월드 미확인'}`),value:c.id,description:truncate(`${c.job??'직업 미확인'} · 등록자 ID ${c.ownerId}`)})))));
  components.push(row(button(`mp:${action}:${p.id}:${view.page-1}:${p.version}`,'이전',ButtonStyle.Secondary,view.page===0),button(`mp:${action}:${p.id}:${view.page+1}:${p.version}`,'다음',ButtonStyle.Secondary,view.page>=view.pages-1),button(`mp:detail:${p.id}`,'파티로 돌아가기')));
  return {embeds:[base().setTitle(`${safe(p.name)} · 캐릭터 ${remove?'제외':'추가'}`).setDescription(view.items.length?'등록된 목록에서 선택하세요. 한 사람당 한 캐릭터씩 편성해요.':remove?'편성된 캐릭터가 없어요.':'추가할 캐릭터가 없어요. 다른 참가자의 캐릭터 등록을 기다리거나 현재 편성한 캐릭터를 먼저 제외해 주세요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 선택 가능 ${view.total}개`})],components,allowedMentions:{parse:[]}};
}
export function bossPicker(p,remove=false) {
  const items=remove?p.bosses.map(x=>bossById(x.bossId)).filter(Boolean):BOSSES.filter(b=>!p.bosses.some(x=>x.bossId===b.id));
  const components=[];
  if(items.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`mp:${remove?'removeboss':'selectboss'}:${p.id}:${p.version}`).setPlaceholder(remove?'제외할 보스':'추가할 보스').addOptions(items.map(b=>({label:b.name,value:b.id})))));
  components.push(row(button(`mp:detail:${p.id}`,'파티로 돌아가기')));
  return {embeds:[base().setTitle(`${safe(p.name)} · 보스 ${remove?'제외':'추가'}`).setDescription(items.length?'파티에 등록할 보스를 선택하세요.':'선택할 보스가 없어요.').setFooter({text:'초기 보스 목록은 src/catalog.js에서 확장할 수 있어요.'})],components,allowedMentions:{parse:[]}};
}
export function difficultyPicker(p,bossId) {
  const b=bossById(bossId);
  return {content:`**${safe(b.name)}**의 난이도를 선택하세요.`,embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`mp:difficulty:${p.id}:${p.version}:${b.id}`).setPlaceholder('난이도').addOptions(b.difficulties.map(d=>({label:d,value:d})))),row(button(`mp:detail:${p.id}`,'파티로 돌아가기'))],allowedMentions:{parse:[]}};
}
export function registrationModal() {
  return new ModalBuilder().setCustomId('mp:modal:apikey').setTitle('내 API 키 연결').addComponents(row(new TextInputBuilder().setCustomId('apikey').setLabel('이 보스방에 모든 캐릭터를 등록할 개인 API 키').setPlaceholder('메이플스토리용 API 키 · 채팅에 보내지 마세요').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(20).setMaxLength(512)));
}
export function creationModal() {return new ModalBuilder().setCustomId('mp:modal:create').setTitle('새 파티 만들기').addComponents(row(new TextInputBuilder().setCustomId('name').setLabel('파티 이름').setPlaceholder('목요일 본캐팟').setMaxLength(60).setStyle(TextInputStyle.Short).setRequired(true)));}
export function archiveConfirmation(p) {
  return {content:`**${safe(p.name)}** 파티를 ${p.archived?'복원':'보관'}할까요? 보관한 파티는 다시 복원할 수 있어요.`,embeds:[],components:[row(button(`mp:confirmarchive:${p.id}:${p.version}:${p.archived?'restore':'store'}`,p.archived?'복원하기':'보관하기',ButtonStyle.Primary),button(`mp:detail:${p.id}`,'취소'))],allowedMentions:{parse:[]}};
}

// A shared card is readable by everyone; editing opens a permission-checked personal panel.
export function publicParty(payload,id) {
  return {...payload,components:[row(button(`mp:detail:${id}`,'열기 · 관리'))]};
}

export function specPicker(state,page=0) {
  const list=paginate(state.characters.filter(c=>c.active),page,25),components=[];
  if(list.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId('mp:selectspec').setPlaceholder('스펙을 볼 캐릭터').addOptions(list.items.map(c=>({label:truncate(c.name),value:c.id})))));
  components.push(pager('mp:specpicker',list.page,list.pages),home());
  return {content:'장비·스킬·전투력·레벨 변화를 볼 캐릭터를 선택하세요.',embeds:[],components};
}
const stamp=time=>new Date(time).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
export function specDetail(character,history,manual,ctx,index=0,page=0) {
  const pos=paginate(history,index,1),current=pos.items[0],previous=history[pos.page+1];
  const changes=current?specChanges(previous,current):['아직 수집한 스펙이 없어요. 스펙 갱신을 누르거나 자동 수집을 기다려 주세요.'];
  const list=paginate(changes,page,8);
  const emb=base().setTitle(`${safe(character.name)} · 스펙 변화`).setDescription(current?`${stamp(current.collectedAt)} 수집 (한국 시간)\n레벨 **${current.level}** · 전투력 **${BigInt(current.combatPower).toLocaleString('ko-KR')}**\n${previous?`${stamp(previous.collectedAt)} 기록과 비교`:'첫 수집 기록'}\n장비 세팅·버프·프리셋에 따라 수치가 달라질 수 있어요.`:'넥슨 API 연결 후 자동으로 기록해요.');
  emb.addFields({name:`변화 ${list.page+1}/${list.pages} · ${changes.length}개`,value:list.items.map(line=>safe(line).slice(0,115)).join('\n').slice(0,1024)});
  if(current?.unavailable?.length) emb.addFields({name:'미제공 항목',value:`${safe(current.unavailable.join(', '))} — 이 항목의 변화는 비교하지 않아요.`});
  const manualLines=[];
  for(const metric of ['주스탯','헥사']) {
    const entries=manual.filter(x=>x.metric===metric);
    if(entries.length) manualLines.push(...entries.slice(0,3).map((x,index)=>`${stamp(x.recorded_at)} · ${metric} ${x.value.toLocaleString('ko-KR')}${entries[index+1]?` (${x.value-entries[index+1].value>=0?'+':''}${(x.value-entries[index+1].value).toLocaleString('ko-KR')})`:''}`));
  }
  emb.addFields({name:'환산 최근 기록 · 사용자 입력 (자동 수집 아님)',value:manualLines.join('\n')||'/캐릭터 환산기록으로 직접 확인한 수치를 기록할 수 있어요.'});
  emb.setFooter({text:'Data based on NEXON Open API · API 기록 최근 29일 · 환산은 수동 기록'});
  const components=[row(button(`mp:spec:${character.id}:${pos.page-1}:0`,'더 최근 기록',ButtonStyle.Secondary,pos.page===0),button(`mp:spec:${character.id}:${pos.page+1}:0`,'이전 기록',ButtonStyle.Secondary,pos.page>=pos.pages-1)),
    row(button(`mp:spec:${character.id}:${pos.page}:${list.page-1}`,'이전 변화',ButtonStyle.Secondary,list.page===0),button(`mp:spec:${character.id}:${pos.page}:${list.page+1}`,'다음 변화',ButtonStyle.Secondary,list.page>=list.pages-1))];
  const links=[new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('환산 사이트 열기').setURL(`https://maplescouter.com/ko/info?name=${encodeURIComponent(character.name)}`)];
  if(character.ownerId===ctx.userId) links.unshift(button(`mp:specsync:${character.id}`,'스펙 갱신',ButtonStyle.Primary),button(`mp:scheduler:${character.id}:0:0`,'내 스케줄러'));
  components.push(row(...links),home());
  return {embeds:[emb],components,allowedMentions:{parse:[]}};
}

export function connectionPanel(status) {
  const text=status.connected?`내 API 키가 연결되어 있어요. API 목록 캐릭터 ${status.count}개 · 마지막 동기화 ${stamp(status.importedAt)}`:'내 메이플스토리 API 키를 연결해 보유 캐릭터를 한 번에 불러오세요.';
  const buttons=[button('mp:apikey',status.connected?'API 키 교체':'API 키 입력',ButtonStyle.Primary,!status.configured)];
  if(status.connected)buttons.push(button('mp:accountsync','캐릭터 동기화'),button('mp:disconnectask','API 연결 해제',ButtonStyle.Danger));
  return {content:`${text}\n\n연결하면 API가 반환하는 모든 캐릭터의 이름·월드·직업이 **현재 보스방에 공개**됩니다. 다른 보스방에는 자동 등록하지 않아요.\n키는 암호화 저장하며 응답에 표시하지 않습니다. 스펙은 하루 한 번, 본인 전용 스케줄러는 매시간 수집을 시도해요.\n${status.configured?'API 연결 해제 시 저장된 키를 삭제하고 자동 수집을 중단합니다.':'서버 운영자가 API_KEY_ENCRYPTION_KEY를 먼저 설정해야 해요.'}`,embeds:[],components:[row(...buttons),home()],allowedMentions:{parse:[]}};
}
export function disconnectConfirmation(version) {
  return {content:'이 보스방의 내 API 연결을 해제할까요? 저장된 키와 캐릭터 API 연결 정보를 삭제하고 자동 수집을 중단합니다. 이미 등록한 캐릭터·파티·기록은 유지하며, API 이력에는 보관 기간이 적용됩니다.',embeds:[],components:[row(button(`mp:disconnect:${version}`,'API 연결 해제',ButtonStyle.Danger),button('mp:register','취소'))],allowedMentions:{parse:[]}};
}
export function schedulerPicker(state,userId,page=0) {
  const list=paginate(state.characters.filter(c=>c.active&&c.ownerId===userId),page,25),components=[];
  if(list.items.length)components.push(row(new StringSelectMenuBuilder().setCustomId('mp:selectscheduler').setPlaceholder('내 캐릭터 선택').addOptions(list.items.map(c=>({label:truncate(c.name),value:c.id})))));
  components.push(pager('mp:schedulerpicker',list.page,list.pages),home());
  return {content:list.items.length?'스케줄러를 볼 내 캐릭터를 선택하세요.':'내 API 키를 연결해 캐릭터를 먼저 불러오세요.',embeds:[],components,allowedMentions:{parse:[]}};
}
export function schedulerDetail(character,history,index=0,page=0) {
  const records=paginate(history,index,1),current=records.items[0],lines=[];
  if(current) {
    for(const [key,label] of [['daily','일일'],['weekly','주간']]) {
      if(current[key]===null) {lines.push(`${label}: 정보 미제공`);continue;}
      for(const item of current[key])lines.push(`[${label}] ${item.name}: ${item.type==='quest'?({'0':'기타','1':'진행 중','2':'완료'}[item.questState]??'미확인'):`${item.now??'?'} / ${item.max??'?'}`}`);
    }
    if(current.bosses===null)lines.push('보스: 정보 미제공');
    else for(const boss of current.bosses)lines.push(`[보스] ${boss.difficulty} ${boss.name}: ${boss.complete===true?'완료':boss.complete===false?'미완료':'미확인'} · ${boss.cycle}`);
  }
  if(!lines.length)lines.push(current?'API가 반환한 스케줄러 항목이 없어요.':'아직 수집한 기록이 없어요. 갱신을 누르거나 자동 수집을 기다려 주세요.');
  const list=paginate(lines,page,8),emb=base().setTitle(`${safe(character.name)} · 내 스케줄러`).setDescription(current?`기준일 ${current.date} · ${stamp(current.collectedAt)} 수집\n주간 보스 ${current.weeklyBossCount??'?'} / ${current.weeklyBossLimit??'?'}\n본인에게만 표시합니다. 파티 클리어·정산에는 자동 반영하지 않아요.`:'개인 API 키로 일일·주간 콘텐츠와 보스 완료 정보를 가져옵니다.');
  emb.addFields({name:`현황 ${list.page+1}/${list.pages}`,value:list.items.map(line=>safe(line).slice(0,120)).join('\n')});
  emb.setFooter({text:'Data based on NEXON Open API · 최근 14일 · 날짜별 마지막 수집 상태'});
  return {embeds:[emb],components:[row(button(`mp:scheduler:${character.id}:${records.page-1}:0`,'최근 날짜',ButtonStyle.Secondary,records.page===0),button(`mp:scheduler:${character.id}:${records.page+1}:0`,'이전 날짜',ButtonStyle.Secondary,records.page>=records.pages-1)),row(button(`mp:scheduler:${character.id}:${records.page}:${list.page-1}`,'이전 항목',ButtonStyle.Secondary,list.page===0),button(`mp:scheduler:${character.id}:${records.page}:${list.page+1}`,'다음 항목',ButtonStyle.Secondary,list.page>=list.pages-1),button(`mp:schedulersync:${character.id}`,'스케줄러 갱신',ButtonStyle.Primary)),home()],allowedMentions:{parse:[]}};
}
