import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { specChanges } from './specs.js';
import { BOSSES, bossById, priceKey, partyLimit } from './catalog.js';
import { formatMeso, partyRevenue, pricedBosses, distribution } from './revenue.js';
import { clearedValue, entryLimit, entryPrice, entryShare } from './records.js';

export const safe=value=>escapeMarkdown(String(value)).replace(/@/g,'＠');
export const button=(id,label,style=ButtonStyle.Secondary,disabled=false)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row=(...items)=>new ActionRowBuilder().addComponents(...items);
export const home=()=>row(button('mp:board','보스방'),button('mp:roster:all:0','캐릭터'),button('mp:parties:active:0','파티'));
const base=()=>new EmbedBuilder().setColor(0x46745b);
// ---- Difficulty badges (Discord ANSI code block; colours show on desktop/web) ----
const ESC='\u001b[';
const color=(code,text)=>`${ESC}${code}m${text}${ESC}0m`;
const BADGES={'이지':['1;37','  EASY  '],'노말':['1;44',' NORMAL '],'하드':['1;45','  HARD  '],'카오스':['1;33;40','  CHAOS  '],'익스트림':['1;31;40',' EXTREME ']};
const BADGE_WIDTH=9;
// Plain text only inside the block: Markdown, links and mentions do not render there, and a backtick would close it.
const plain=value=>String(value).replace(/`/g,'ˋ').replace(/[\x00-\x1f]/g,'');
// The coloured badge keeps its own padding; extra spaces outside it line up the boss names.
export function bossBadge(difficulty,name) {
  const [code,label]=BADGES[difficulty]??['1;37',` ${plain(difficulty)} `];
  return `${color(code,label)}${' '.repeat(Math.max(0,BADGE_WIDTH-label.length))} ${color('1;37',plain(name))}`;
}
export const strong=text=>color('1;37',plain(text));
// Wraps lines in one ansi block that fits `max` characters, cutting at a line boundary.
export function ansiBlock(lines,max=1024) {
  const open='```ansi\n',close='\n```',kept=[];let size=open.length+close.length;
  for(const [i,line] of lines.entries()) {
    const more=lines.length-i-1,cost=line.length+(kept.length?1:0);
    if(size+cost+(more?12:0)>max) {kept.push(`… 외 ${lines.length-i}개`);break;}
    kept.push(line);size+=cost;
  }
  return `${open}${kept.join('\n')}${close}`;
}
// Splits lines into several complete ansi blocks of at most `max` characters each (for multiple fields).
export function ansiChunks(lines,max=1024) {
  const chunks=[];let current=[];
  for(const line of lines) {
    if(current.length&&ansiBlock([...current,line],Infinity).length>max) {chunks.push(current);current=[];}
    current.push(line);
  }
  if(current.length) chunks.push(current);
  return chunks.map(c=>ansiBlock(c,max));
}
const truncate=(s,max=100)=>String(s).slice(0,max);
export function paginate(items,page=0,size=15) {
  const pages=Math.max(1,Math.ceil(items.length/size));
  const current=Math.max(0,Math.min(Number.isSafeInteger(page)?page:0,pages-1));
  return {items:items.slice(current*size,(current+1)*size),page:current,pages,total:items.length};
}
// Direction suffixes keep page controls distinct from home links to the same page.
const pager=(prefix,page,pages)=>row(button(`${prefix}:${page-1}:prev`,'이전',ButtonStyle.Secondary,page===0),button(`${prefix}:${page+1}:next`,'다음',ButtonStyle.Secondary,page>=pages-1));
export function board(state,schedules=[]) {
  const count=state.characters.filter(c=>c.active).length, parties=state.parties.filter(p=>!p.archived);
  return {embeds:[base().setTitle('🍁 우리들의 보스방').setDescription('내 API 키로 캐릭터를 불러오고, 목록에서 골라 파티를 만들어 보세요.\n이 채널 또는 스레드 안에서 여러 파티와 파티별 보스를 관리해요.').addFields(
    {name:'등록 캐릭터',value:`${count}개`,inline:true},{name:'활성 파티',value:`${parties.length}개`,inline:true},
    {name:'파티 미리보기',value:parties.slice(0,6).map(p=>`• ${safe(p.name)} · ${p.characterIds.length}명 · 보스 ${p.bosses.length}개`).join('\n')||'아직 파티가 없어요. 파티 만들기부터 시작하세요.'},
    {name:'다음 보스 일정',value:schedules.slice(0,3).map(s=>`• ${safe(s.partyName)} · ${new Date(s.startAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false})}${s.status==='poll'?' · 투표 중':''}`).join('\n').slice(0,1000)||'등록된 일정이 없어요. 파티 정보에서 일정 잡기를 눌러 주세요.'}
  ).setFooter({text:'캐릭터 수 제한 없음 · API 연결은 본인만 · 편성은 파티 생성자/관리자'})],components:[row(button('mp:register','내 API 키 연결',ButtonStyle.Primary),button('mp:roster:all:0','캐릭터 목록'),button('mp:create','파티 만들기',ButtonStyle.Primary)),row(button('mp:parties:active:0','파티 목록'),button('mp:parties:archived:0','보관함'),button('mp:board','새로고침'),button('sc:list:0','일정 목록'),button('sc:mine:0','내 일정'))],allowedMentions:{parse:[]}};
}
export const scouterUrl=name=>`https://maplescouter.com/ko/info?name=${encodeURIComponent(name)}`;
const power=value=>{
  try {
    if(value==null||!/^\d+$/.test(String(value))) return '미수집';
    const n=BigInt(value),eok=n/100000000n,man=n%100000000n/10000n,rest=n%10000n;
    const parts=[];
    if(eok) parts.push(`${eok}억`);
    if(man) parts.push(`${man}만`);
    if(rest||!parts.length) parts.push(String(rest));
    return parts.join(' ');
  } catch {return '미수집';}
};
// [닉네임](환산 사이트) · 월드 - @등록자 / 직업 / 전투력 : ####
export function roster(state,page=0,owner='all',eligibleOwnerIds=null,powers=null) {
  const chars=state.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner));const view=paginate(chars,page,10);
  const lines=view.items.map(c=>`[**${safe(c.name)}**](${scouterUrl(c.name)}) · ${safe(c.world??'월드 미확인')} - <@${c.ownerId}>${eligibleOwnerIds&&!eligibleOwnerIds.has(c.ownerId)?' · ⚠️ 현재 참가자 아님':''}\n${safe(c.job??'직업 미확인')} / 전투력 : ${power(powers?.get(c.id))}`);
  return {embeds:[base().setTitle('보스방 캐릭터 목록').setDescription(lines.join('\n\n')||'등록된 캐릭터가 없어요. 내 API 키 연결을 눌러 주세요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 총 ${view.total}개 · 기존 수동 등록과 API로 불러온 캐릭터가 함께 표시돼요.`})],components:[pager(`mp:roster:${owner}`,view.page,view.pages),row(button('mp:register','캐릭터 추가 / 삭제',ButtonStyle.Primary),button('mp:specpicker:0','스펙 변화'),button('mp:bhpicker:0','보스 히스토리'),button('mp:schedulerpicker:0','내 스케줄러')),home()],allowedMentions:{parse:[]}};
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
export function partyDetail(state,p,ctx,warnings=[],prices=null) {
  const chars=p.characterIds.map(id=>state.characters.find(c=>c.id===id)).filter(Boolean);
  const canEdit=ctx.isManager||p.creatorId===ctx.userId;
  const emb=base().setTitle(`${p.archived?'📦':'⚔️'} ${safe(p.name)}`).setDescription(`만든 사람 <@${p.creatorId}> · ${chars.length}명${p.archived?' · 보관됨':''}`).addFields(
    {name:'파티 캐릭터',value:chars.slice(0,12).map(c=>`• **${safe(c.name)}** · ${safe(c.job??'직업 미확인')} · <@${c.ownerId}>${ctx.eligibleOwnerIds&&!ctx.eligibleOwnerIds.has(c.ownerId)?' ⚠️ 현재 참가자 아님':''}`).join('\n').slice(0,1000)||'아직 비어 있어요. 아래에서 캐릭터를 추가하세요.'},
    {name:'등록 보스',value:p.bosses.length?ansiBlock(p.bosses.map((b,i)=>`${String(i+1).padStart(2)}. ${bossBadge(b.difficulty,bossById(b.bossId)?.name??b.bossId)}`)):'보스가 아직 등록되지 않았어요.'}
  ).setFooter({text:`구성 버전 ${p.version} · 캐릭터·보스 변경은 이 파티에만 반영돼요.`});
  if(chars.length>12) emb.addFields({name:'전체 구성원',value:`총 ${chars.length}명 중 12명을 표시했어요. 캐릭터 목록이나 제외 메뉴에서 나머지를 확인하세요.`});
  if(warnings.length) emb.addFields({name:'편성 확인',value:warnings.slice(0,3).map(safe).join('\n').slice(0,1000)});
  if(prices&&p.bosses.length) {
    const r=partyRevenue(p,prices);
    const lines=r.lines.map(x=>`${bossBadge(x.difficulty,x.boss?.name??'알 수 없는 보스')} ${x.price?`${strong(formatMeso(x.share))} (${formatMeso(x.price)} ÷ ${x.divisor}명${x.boss.monthly?' · 월간':''})`:'솔플 가정 · 가격 없음'}`);
    emb.addFields({name:'결정석 수익 · 1인 기준',value:`${ansiBlock(lines,960)}**주간 합계 ${formatMeso(r.weekly)}**${r.monthly?` · 월간 ${formatMeso(r.monthly)}`:''}`});
  }
  const components=[];const token=`${p.id}:0:${p.version}`;
  if(canEdit&&!p.archived) components.push(row(button(`mp:addmember:${token}`,'캐릭터 추가',ButtonStyle.Primary),button(`mp:delmember:${token}`,'캐릭터 제외'),button(`mp:addboss:${token}`,'보스 추가',ButtonStyle.Primary),button(`mp:delboss:${token}`,'보스 제외')));
  const secondary=[button(`mp:copy:${p.id}`,'구성 복사')];
  if(!p.archived) secondary.push(button(`sc:start:${p.id}`,'일정 잡기'));
  if(!p.archived) secondary.push(button(`mp:dist:${p.id}`,'분배금 계산'));
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
  components.push(row(button(`mp:${action}:${p.id}:${view.page-1}:${p.version}`,'이전',ButtonStyle.Secondary,view.page===0),button(`mp:${action}:${p.id}:${view.page+1}:${p.version}`,'다음',ButtonStyle.Secondary,view.page>=view.pages-1),button(`mp:detail:${p.id}`,'파티로 돌아가기')),home());
  return {embeds:[base().setTitle(`${safe(p.name)} · 캐릭터 ${remove?'제외':'추가'}`).setDescription(view.items.length?'등록된 목록에서 선택하세요. 한 사람당 한 캐릭터씩 편성해요.':remove?'편성된 캐릭터가 없어요.':'추가할 캐릭터가 없어요. 다른 참가자의 캐릭터 등록을 기다리거나 현재 편성한 캐릭터를 먼저 제외해 주세요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 선택 가능 ${view.total}개`})],components,allowedMentions:{parse:[]}};
}
export function bossPicker(p,remove=false) {
  const items=remove?p.bosses.map(x=>bossById(x.bossId)).filter(Boolean):BOSSES.filter(b=>!p.bosses.some(x=>x.bossId===b.id));
  const components=[];
  if(items.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`mp:${remove?'removeboss':'selectboss'}:${p.id}:${p.version}`).setPlaceholder(remove?'제외할 보스':'추가할 보스').addOptions(items.map(b=>({label:b.name,value:b.id})))));
  components.push(row(button(`mp:detail:${p.id}`,'파티로 돌아가기')),home());
  return {embeds:[base().setTitle(`${safe(p.name)} · 보스 ${remove?'제외':'추가'}`).setDescription(items.length?'파티에 등록할 보스를 선택하세요.':'선택할 보스가 없어요.').setFooter({text:'초기 보스 목록은 src/catalog.js에서 확장할 수 있어요.'})],components,allowedMentions:{parse:[]}};
}
export function difficultyPicker(p,bossId) {
  const b=bossById(bossId);
  return {content:`**${safe(b.name)}**의 난이도를 선택하세요.`,embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`mp:difficulty:${p.id}:${p.version}:${b.id}`).setPlaceholder('난이도').addOptions(b.difficulties.map(d=>({label:d,value:d})))),row(button(`mp:detail:${p.id}`,'파티로 돌아가기')),home()],allowedMentions:{parse:[]}};
}
export function registrationModal() {
  return new ModalBuilder().setCustomId('mp:modal:apikey').setTitle('내 API 키 연결').addComponents(row(new TextInputBuilder().setCustomId('apikey').setLabel('캐릭터를 선택해 등록할 개인 API 키').setPlaceholder('메이플스토리용 API 키 · 채팅에 보내지 마세요').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(20).setMaxLength(512)));
}
export function creationModal() {return new ModalBuilder().setCustomId('mp:modal:create').setTitle('새 파티 만들기').addComponents(row(new TextInputBuilder().setCustomId('name').setLabel('파티 이름').setPlaceholder('목요일 본캐팟').setMaxLength(60).setStyle(TextInputStyle.Short).setRequired(true)));}
export function archiveConfirmation(p) {
  return {content:`**${safe(p.name)}** 파티를 ${p.archived?'복원':'보관'}할까요? 보관한 파티는 다시 복원할 수 있어요.`,embeds:[],components:[row(button(`mp:confirmarchive:${p.id}:${p.version}:${p.archived?'restore':'store'}`,p.archived?'복원하기':'보관하기',ButtonStyle.Primary),button(`mp:detail:${p.id}`,'취소')),home()],allowedMentions:{parse:[]}};
}

// A shared card is readable by everyone; editing opens a permission-checked personal panel.
export function publicParty(payload,id) {
  return {...payload,components:[row(button(`mp:detail:${id}`,'열기 · 관리')),home()]};
}

export function specPicker(state,page=0) {
  const list=paginate(state.characters.filter(c=>c.active),page,25),components=[];
  if(list.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId('mp:selectspec').setPlaceholder('스펙을 볼 캐릭터').addOptions(list.items.map(c=>({label:truncate(c.name),value:c.id})))));
  components.push(pager('mp:specpicker',list.page,list.pages),home());
  return {content:'장비·스킬·전투력·레벨 변화를 볼 캐릭터를 선택하세요.',embeds:[],components};
}
// Same entry pattern as 스펙 변화: pick a character, then open its boss history.
export function bossHistoryPicker(characters,page=0) {
  const list=paginate(characters,page,25),components=[];
  if(list.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId('mp:selectbh').setPlaceholder('보스 히스토리를 볼 캐릭터').addOptions(list.items.map(c=>({label:truncate(c.name),value:c.id,description:truncate(`${c.world??'월드 미확인'} · ${c.job??'직업 미확인'}`)})))));
  components.push(pager('mp:bhpicker',list.page,list.pages),home());
  return {content:list.items.length?'보스 히스토리를 볼 캐릭터를 선택하세요. 내 캐릭터와 같은 파티원의 캐릭터만 볼 수 있어요.':'볼 수 있는 캐릭터가 없어요. 캐릭터를 등록하거나 파티에 편성해 주세요.',embeds:[],components,allowedMentions:{parse:[]}};
}
const stamp=time=>new Date(time).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
export function specDetail(character,history,manual,ctx,index=0,page=0) {
  const pos=paginate(history,index,1),current=pos.items[0],previous=history[pos.page+1];
  const changes=current?specChanges(previous,current):['아직 수집한 스펙이 없어요. 스펙 확인을 누르거나 자동 수집을 기다려 주세요.'];
  const list=paginate(changes,page,8);
  const emb=base().setTitle(`${safe(character.name)} · 스펙 변화`).setDescription(current?`${stamp(current.collectedAt)} 수집 (한국 시간)\n레벨 **${current.level}** · 전투력 **${power(current.combatPower)}**\n${previous?`${stamp(previous.collectedAt)} 기록과 비교`:'첫 수집 기록'}\nAPI 반영이 지연될 수 있어요. 스펙 확인을 누르면 다시 조회해요.`:'넥슨 API 연결 후 자동으로 기록해요.');
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
  const links=[new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('환산 사이트 열기').setURL(scouterUrl(character.name))];
  if(character.ownerId===ctx.userId) links.unshift(button(`mp:specsync:${character.id}`,'스펙 확인',ButtonStyle.Primary),button(`mp:scheduler:${character.id}:0:0`,'내 스케줄러'));
  components.push(row(...links),home());
  return {embeds:[emb],components,allowedMentions:{parse:[]}};
}

export function connectionPanel(status) {
  const text=status.connected?`내 API 키가 연결되어 있어요. 내 등록 캐릭터 ${status.count}개 · 마지막 동기화 ${stamp(status.importedAt)}`:'내 메이플스토리 API 키를 연결해 등록할 캐릭터를 선택하세요.';
  const buttons=[button('mp:apikey',status.connected?'API 키 교체':'API 키 입력',ButtonStyle.Primary,!status.configured)];
  if(status.connected)buttons.push(button('mp:charadd','캐릭터 추가',ButtonStyle.Success),button('mp:accountsync','계정 목록 갱신'));
  buttons.push(button('mp:charremove','캐릭터 삭제',ButtonStyle.Danger));
  return {content:`${text}\n\nAPI 연결 → 캐릭터 여러 개 선택 → 등록 완료 순서로 진행해요. **선택해 등록한 캐릭터만 현재 보스방에 공개**됩니다. 계정 목록 갱신으로 새 캐릭터가 자동 등록되지는 않아요.\n키는 암호화 저장하며 응답에 표시하지 않습니다. 등록한 API 캐릭터만 스펙은 하루 한 번, 본인 전용 스케줄러는 매시간 수집을 시도해요.\n${status.configured?'API 연결 해제 시 저장된 키를 삭제하고 자동 수집을 중단합니다.':'서버 운영자가 API_KEY_ENCRYPTION_KEY를 먼저 설정해야 해요.'}`,embeds:[],components:[row(...buttons),...(status.connected?[row(button('mp:disconnectask','API 연결 해제',ButtonStyle.Danger))]:[]),home()],allowedMentions:{parse:[]}};
}
export function characterSelection(draft,page=0) {
  const list=paginate(draft.items,page,25),removing=draft.mode==='remove',components=[];
  if(list.items.length)components.push(row(new StringSelectMenuBuilder().setCustomId(`mp:charselect:${draft.id}:${list.page}`).setPlaceholder(removing?'삭제할 내 캐릭터 여러 개 선택':'등록할 캐릭터 여러 개 선택').setMinValues(0).setMaxValues(list.items.length).addOptions(list.items.map(c=>({label:truncate(`${c.level!=null?`Lv.${c.level} `:''}${c.name} · 전투력 ${c.combatPower!=null?power(c.combatPower):'조회 불가'}`),description:truncate(`${c.world??'월드 미확인'} · ${c.job??'직업 미확인'}`),value:c.value,default:draft.selected.has(c.value)})))));
  components.push(pager(`mp:charpage:${draft.id}`,list.page,list.pages),row(button(`mp:charcomplete:${draft.id}`,removing?'선택 캐릭터 삭제':'등록 완료',removing?ButtonStyle.Danger:ButtonStyle.Success,draft.selected.size===0),button('mp:register','취소')),home());
  return {content:`${removing?'삭제할 내 캐릭터':'등록할 캐릭터'}를 여러 개 선택한 뒤 **${removing?'선택 캐릭터 삭제':'등록 완료'}**를 눌러 주세요.\n${list.page+1}/${list.pages} 페이지 · 후보 ${list.total}개 · 선택 ${draft.selected.size}개\n전투력 높은 순 · 전투력은 조회 시점 기준이며 1시간 동안 재사용해요.\n페이지를 이동해도 선택은 유지돼요. ${removing?'현재 파티에 편성 중이면 먼저 파티에서 제외해 주세요. 삭제해도 과거 기록은 보존합니다.':'선택 전 계정 목록은 본인에게만 보여요.'}${list.total?'':'\n선택 가능한 캐릭터가 없어요.'}`,embeds:[],components,allowedMentions:{parse:[]}};
}
export function disconnectConfirmation(version) {
  return {content:'이 보스방의 내 API 연결을 해제할까요? 저장된 키와 캐릭터 API 연결 정보를 삭제하고 자동 수집을 중단합니다. 이미 등록한 캐릭터·파티·기록은 유지하며, API 이력에는 보관 기간이 적용됩니다.',embeds:[],components:[row(button(`mp:disconnect:${version}`,'API 연결 해제',ButtonStyle.Danger),button('mp:register','취소')),home()],allowedMentions:{parse:[]}};
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

// ---- 결정석 가격표 ----
// One line per boss difficulty, cheapest first: "[badge] 보스명 · 가격 · 최대 N인".
export function priceTable({prices,overrides}) {
  const rows=pricedBosses().flatMap(b=>b.priced.map(d=>({b,d,key:priceKey(b.id,d)}))).sort((x,y)=>prices[x.key]-prices[y.key]||BOSSES.indexOf(x.b)-BOSSES.indexOf(y.b));
  const lines=rows.map(({b,d,key})=>`${bossBadge(d,b.name)} · ${formatMeso(prices[key])} · ${partyLimit(b,d)}인${b.monthly?' · 월간':''}${overrides.has(key)?' ✏️':''}`);
  const chunks=ansiChunks(lines);
  const emb=base().setTitle('결정석 가격표').setDescription(`가격이 낮은 순 · ${rows.length}개 · 인원은 결정석을 나누는 최대 인원`)
    .addFields(chunks.map((value,i)=>({name:chunks.length>1?`가격표 ${i+1}/${chunks.length}`:'가격표',value})))
    .setFooter({text:'✏️ 서버에서 수정한 가격 · /결정석 가격수정 보스 난이도 가격 · 노말 진 힐라 이하는 솔플 가정'});
  return {embeds:[emb],components:[home()],allowedMentions:{parse:[]}};
}

// ---- 보스 기록 ----
// split=true shows how a saved clear is divided: "가격 ÷ N명 = 1인 몫".
// Weekly bosses first and numbered; monthly bosses go last without a number.
// `index` stays the position in the saved list so edits keep pointing at the same entry.
const ordered=cleared=>{
  const rows=cleared.map((b,index)=>({b,index}));let no=0;
  return [...rows.filter(r=>!r.b.monthly),...rows.filter(r=>r.b.monthly)].map(r=>({...r,no:r.b.monthly?null:++no}));
};
// Lines for an ansi block: "1. [badge] 보스명 · 가격 ÷ N명 = 1인 몫"; monthly bosses get "•" and "(월간)".
const clearedLines=(cleared,prices,split=false)=>ordered(cleared).map(({b,no})=>{
  const price=entryPrice(b,prices),label=`${split&&no?`${String(no).padStart(2)}.`:' •'} ${bossBadge(b.difficulty,b.name)}${b.monthly?' (월간)':''}`;
  if(!price) return `${label}${split?' · 가격 없음':''}`;
  return split?`${label} · ${formatMeso(price)} ÷ ${b.partySize??1}명 = ${strong(formatMeso(entryShare(b,prices)))}`:`${label} · ${formatMeso(price)}`;
});
const clearedBlock=(cleared,prices,split,max,empty)=>cleared.length?ansiBlock(clearedLines(cleared,prices,split),max):empty;
const count=(n,limit)=>`${n??'?'}/${limit??'?'}`;
// Loaded (not yet saved) week opened from the history: save / skip / refresh / back.
export function bossRecord(record,prices,{fetched=false,refreshed=null}={}) {
  const source=fetched?'방금 API에서 불러왔어요.':`${stamp(record.collectedAt)}에 수집한 캐시예요.${record.final?' (지난 날짜 확정 기록)':''}`;
  const emb=base().setTitle(`${safe(record.characterName)} · ${weekLabel(record.week)} 보스 기록 (저장 전)`).setDescription(`${record.day} 기준 · 주간 보스 ${count(record.clearCount,record.clearLimit)} 클리어\n결정석 가격 합계(1인 기준) **${formatMeso(clearedValue(record.cleared,prices))}**\n${source}\n\n**클리어한 보스 ${record.cleared.length}개**\n${clearedBlock(record.cleared,prices,false,3500,'클리어한 보스가 없어요.')}`)
    .setFooter({text:'Data based on NEXON Open API · 갱신은 등록자의 API 키로 다시 조회해요.'});
  const content=`${refreshed==='cached'?'최근에 수집한 기록이라 다시 조회하지 않았어요. ':''}이 주차 기록을 히스토리에 저장할까요? 저장하면 함께 클리어한 인원을 편집할 수 있어요.`;
  return {content,embeds:[emb],components:[row(button(`mp:bhsave:${record.characterId}:${record.day}:${record.collectedAt}`,'저장',ButtonStyle.Primary),button(`mp:bhskip:${record.characterId}`,'저장 안 함'),button(`mp:bhrefresh:${record.characterId}:${record.period??'current'}`,'갱신'),button(`mp:bhist:${record.characterId}:0`,'히스토리로')),home()],allowedMentions:{parse:[]}};
}
// "11월 2주차 (11/12~11/18)": weeks start on the Thursday reset; n counts that month's Thursdays.
export function weekLabel(week) {
  const d=new Date(`${week}T00:00:00Z`),end=new Date(d.getTime()+6*86400_000),md=x=>`${x.getUTCMonth()+1}/${x.getUTCDate()}`;
  return `${d.getUTCMonth()+1}월 ${Math.ceil(d.getUTCDate()/7)}주차 (${md(d)}~${md(end)})`;
}
// History shows only the week picked in the dropdown. Saved weeks come from the database;
// this week and last week appear as "저장 전" until saved, and picking them loads a preview.
export function bossHistory({character,options},prices,{selected=null,canEdit=false,notice=null,page=0}={}) {
  const current=options.find(o=>o.week===selected&&o.saved),savedCount=options.filter(o=>o.saved).length;
  const emb=base();
  if(current) {
    const w=current.data;
    emb.setTitle(`${safe(character.name)} · ${weekLabel(w.week)}`).setDescription(`주간 보스 ${count(w.clearCount,w.clearLimit)} 클리어 · 1인 몫 합계 **${formatMeso(clearedValue(w.cleared,prices))}**\n\n**클리어한 보스 ${w.cleared.length}개**\n${clearedBlock(w.cleared,prices,true,3800,'클리어 없음')}`);
  } else emb.setTitle(`${safe(character.name)} · 보스 히스토리`).setDescription(savedCount?`저장한 주차 ${savedCount}개 · 아래에서 주차를 선택하세요.`:'저장한 기록이 없어요. 아래 저장 버튼으로 이번 주·지난주 기록을 바로 저장하거나, 주차를 골라 먼저 확인하세요.');
  emb.setFooter({text:'결정석 금액은 현재 가격표 기준 · 저장한 주차는 다시 불러오지 않아요 · 인원은 등록자가 편집해요'});
  const list=paginate(options,page,25);
  const components=[row(new StringSelectMenuBuilder().setCustomId(`mp:bhpick:${character.id}`).setPlaceholder('주차 선택').addOptions(list.items.map(o=>({
    label:truncate(weekLabel(o.week)),value:o.week,default:o.week===selected,
    description:truncate(o.saved?`${o.period==='current'?'이번 주 · ':o.period==='last'?'지난주 · ':''}저장됨 · 클리어 ${o.data.cleared.length}개 · 1인 몫 ${formatMeso(clearedValue(o.data.cleared,prices))}`:`${o.period==='current'?'이번 주':'지난주'} · 저장 전 (선택하면 불러와요)`)}))))];
  // Save buttons for this week / last week while they are not saved yet.
  const unsaved=options.filter(o=>!o.saved&&o.period).sort((a,b)=>a.period==='current'?-1:1);
  if(unsaved.length) components.push(row(...unsaved.map(o=>button(`mp:bhquick:${character.id}:${o.period}`,`${o.period==='current'?'이번 주':'지난주'} 저장`,ButtonStyle.Success))));
  const actions=[];
  if(current&&canEdit&&current.data.cleared.length) actions.push(button(`mp:bhedit:${character.id}:${current.week}`,'인원 편집',ButtonStyle.Primary));
  if(current?.period==='current') actions.push(button(`mp:bhreload:${character.id}:current`,'이번 주 다시 불러오기'));
  actions.push(button('mp:bhpicker:0','다른 캐릭터'));
  components.push(row(...actions));
  if(list.pages>1) components.push(pager(`mp:bhist:${character.id}`,list.page,list.pages));
  components.push(home());
  return {content:notice,embeds:[emb],components,allowedMentions:{parse:[]}};
}
// Week editor: pick one cleared boss, then pick how many people shared it.
export function bossWeekEditor({character,week:w},prices,notice=null) {
  const emb=base().setTitle(`${safe(character.name)} · ${weekLabel(w.week)} 편집`).setDescription(`${clearedBlock(w.cleared,prices,true,3800,'클리어 없음')}\n**1인 몫 합계 ${formatMeso(clearedValue(w.cleared,prices))}**`)
    .setFooter({text:'보스를 고르고 함께 클리어한 인원을 선택하면 결정석 가격을 그 인원만큼 나눠요.'});
  const options=ordered(w.cleared).slice(0,25).map(({b,index:i,no})=>({label:truncate(no?`${no}. ${b.difficulty} ${b.name}`:`${b.difficulty} ${b.name} (월간)`),value:String(i),description:truncate(`${b.partySize??1}인 · 최대 ${entryLimit(b)}인${entryPrice(b,prices)?` · 1인 ${formatMeso(entryShare(b,prices))}`:' · 가격 없음'}`)}));
  return {content:notice,embeds:[emb],components:[row(new StringSelectMenuBuilder().setCustomId(`mp:bhboss:${character.id}:${w.week}:${w.rev??0}`).setPlaceholder('인원을 바꿀 보스 선택').addOptions(options)),row(button(`mp:bhshow:${character.id}:${w.week}`,'히스토리로 돌아가기')),home()],allowedMentions:{parse:[]}};
}
export function partySizePicker({character,week:w},index,prices) {
  const b=w.cleared[index],price=entryPrice(b,prices),limit=entryLimit(b);
  const options=Array.from({length:limit},(_,n)=>n+1).map(n=>({label:`${n}인${n===1?' (솔플)':''}`,value:String(n),default:(b.partySize??1)===n,description:price?truncate(`1인 ${formatMeso(Math.floor(price/n))}`):'가격 없음'}));
  return {content:`**${safe(b.difficulty)} ${safe(b.name)}** · 함께 클리어한 인원을 선택하세요. (최대 ${limit}인)`,embeds:[],components:[row(new StringSelectMenuBuilder().setCustomId(`mp:bhsize:${character.id}:${w.week}:${w.rev??0}:${index}`).setPlaceholder('인원 선택').addOptions(options)),row(button(`mp:bhedit:${character.id}:${w.week}`,'주차 편집으로 돌아가기'),button(`mp:bhshow:${character.id}:${w.week}`,'히스토리로 돌아가기')),home()],allowedMentions:{parse:[]}};
}

// ---- 분배금 ----
export function distQuestion(p) {
  return {content:`**${safe(p.name)}** · 분배할 아이템이 있나요?`,embeds:[],components:[row(button(`mp:distyes:${p.id}`,'예',ButtonStyle.Primary),button(`mp:distno:${p.id}`,'아니오')),row(button(`mp:distlist:${p.id}:0`,'분배 기록'),button(`mp:detail:${p.id}`,'파티로 돌아가기')),home()],allowedMentions:{parse:[]}};
}
export function distSellerPicker(p) {
  return {content:`**${safe(p.name)}** · 판매자를 선택하세요. 파티에 캐릭터가 편성된 사람만 선택할 수 있어요.`,embeds:[],components:[row(new UserSelectMenuBuilder().setCustomId(`mp:distseller:${p.id}`).setPlaceholder('판매자 @선택').setMinValues(1).setMaxValues(1)),row(button(`mp:detail:${p.id}`,'취소')),home()],allowedMentions:{parse:[]}};
}
export function distModal(customId,record=null) {
  const modal=new ModalBuilder().setCustomId(customId).setTitle(record?'분배 기록 수정':'분배 품목 입력').addComponents(
    row(new TextInputBuilder().setCustomId('item').setLabel('거래 품목').setPlaceholder('예: 미트라의 분노').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)),
    row(new TextInputBuilder().setCustomId('price').setLabel('거래금 (경매장 판매 금액)').setPlaceholder('예: 25억 또는 2500000000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)));
  // Prefill only when editing; Discord rejects empty prefilled values.
  if(record) {
    const [item,price]=modal.components.map(r=>r.components[0]);item.setValue(record.item);price.setValue(String(record.price));
    modal.addComponents(row(new TextInputBuilder().setCustomId('members').setLabel('파티원 수 n (판매자 포함)').setPlaceholder('1~6').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(record.memberCount))));
  }
  return modal;
}
export function distCard(record) {
  const r=distribution(record.price,record.memberCount);
  const lines=[`판매자 닉네임 : <@${record.sellerId}>`,'',`거래 품목 : ${safe(record.item)} 거래금 - ${formatMeso(r.price)}`,'',`판매자 실수령액 - ${formatMeso(r.net)}`];
  if(record.mvp) lines.push(`MVP 할인가 - ${formatMeso(r.mvpNet)}`);
  lines.push('',`최종 수령 금액 (${r.memberCount}명 기준) - ${formatMeso(r.share)}`);
  if(record.mvp) lines.push(`MVP 할인가 - ${formatMeso(r.mvpShare)}`);
  const formulas=['판매자 실수령액 = 거래금 × 0.95',`최종 수령 금액 = 실수령액 ÷ ${r.memberCount} × 0.95`];
  if(record.mvp) formulas.push('MVP 실수령액 = 거래금 × 0.97',`MVP 최종 수령 금액 = MVP 실수령액 ÷ ${r.memberCount} × 0.97`);
  const emb=base().setTitle(`분배금 계산 결과 · ${safe(record.partyName)}`).setDescription(lines.join('\n'))
    .addFields({name:'계산식',value:formulas.join('\n')})
    .setFooter({text:`n = 파티원 수 ${r.memberCount}명 (판매자 포함)${record.edits?` · 수정 ${record.edits}회`:''} · 품목·거래금·파티원 수 수정은 판매자만`});
  return {embeds:[emb],components:[row(button(`mp:distedit:${record.id}`,'수정'),button(`mp:distmvp:${record.id}`,record.mvp?'MVP 할인 해제':'MVP 할인 적용',record.mvp?ButtonStyle.Success:ButtonStyle.Secondary)),home()],allowedMentions:{parse:[]}};
}
export function distList(p,records,page=0) {
  const view=paginate(records,page,10),components=[];
  if(view.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId('mp:distopen').setPlaceholder('분배 기록 열기').addOptions(view.items.map(r=>({label:truncate(`${r.item} · ${formatMeso(r.price)}`),value:r.id,description:truncate(new Date(r.createdAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}))})))));
  components.push(pager(`mp:distlist:${p.id}`,view.page,view.pages),row(button(`mp:dist:${p.id}`,'새 분배',ButtonStyle.Primary),button(`mp:detail:${p.id}`,'파티로 돌아가기')),home());
  return {embeds:[base().setTitle(`${safe(p.name)} · 분배 기록`).setDescription(view.items.map(r=>`**${safe(r.item)}** · ${formatMeso(r.price)} · 판매자 <@${r.sellerId}>${r.mvp?' · MVP':''}`).join('\n')||'분배 기록이 없어요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 총 ${view.total}건`})],components,allowedMentions:{parse:[]}};
}
export const backToParty=id=>row(button(`mp:detail:${id}`,'파티로 돌아가기'));
