import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
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
  return {embeds:[base().setTitle('🍁 우리들의 보스방').setDescription('각자 캐릭터를 등록하고, 목록에서 골라 파티를 만들어 보세요.\n이 채널 또는 스레드 안에서 여러 파티와 파티별 보스를 관리해요.').addFields(
    {name:'등록 캐릭터',value:`${count}개`,inline:true},{name:'활성 파티',value:`${parties.length}개`,inline:true},
    {name:'파티 미리보기',value:parties.slice(0,6).map(p=>`• ${safe(p.name)} · ${p.characterIds.length}명 · 보스 ${p.bosses.length}개`).join('\n')||'아직 파티가 없어요. 파티 만들기부터 시작하세요.'}
  ).setFooter({text:'캐릭터 수 제한 없음 · 등록은 본인만 · 편성은 파티 생성자/관리자'})],components:[row(button('mp:register','내 캐릭터 등록',ButtonStyle.Primary),button('mp:roster:all:0','캐릭터 목록'),button('mp:create','파티 만들기',ButtonStyle.Primary)),row(button('mp:parties:active:0','파티 목록'),button('mp:parties:archived:0','보관함'),button('mp:board','새로고침'))],allowedMentions:{parse:[]}};
}
export function roster(state,page=0,owner='all',eligibleOwnerIds=null) {
  const chars=state.characters.filter(c=>c.active&&(owner==='all'||c.ownerId===owner));const view=paginate(chars,page,10);
  const lines=view.items.map(c=>`**${safe(c.name)}** · ${safe(c.world)} / ${safe(c.job)}\n등록자 <@${c.ownerId}>${eligibleOwnerIds&&!eligibleOwnerIds.has(c.ownerId)?' · ⚠️ 현재 참가자 아님':''}`);
  return {embeds:[base().setTitle('보스방 캐릭터 목록').setDescription(lines.join('\n\n')||'등록된 캐릭터가 없어요. 각자 내 캐릭터 등록을 눌러 주세요.').setFooter({text:`${view.page+1}/${view.pages} 페이지 · 총 ${view.total}개 · 닉네임 등록은 소유 인증 전 상태예요.`})],components:[pager(`mp:roster:${owner}`,view.page,view.pages),row(button('mp:register','내 캐릭터 등록',ButtonStyle.Primary)),home()],allowedMentions:{parse:[]}};
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
    {name:'파티 캐릭터',value:chars.slice(0,12).map(c=>`• **${safe(c.name)}** · ${safe(c.job)} · <@${c.ownerId}>${ctx.eligibleOwnerIds&&!ctx.eligibleOwnerIds.has(c.ownerId)?' ⚠️ 현재 참가자 아님':''}`).join('\n').slice(0,1000)||'아직 비어 있어요. 아래에서 캐릭터를 추가하세요.'},
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
  if(view.items.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`mp:${remove?'removemember':'selectmember'}:${p.id}:${p.version}`).setPlaceholder(remove?'제외할 캐릭터':'추가할 캐릭터').addOptions(view.items.map(c=>({label:truncate(`${c.name} · ${c.world}`),value:c.id,description:truncate(`${c.job} · 등록자 ID ${c.ownerId}`)})))));
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
  return new ModalBuilder().setCustomId('mp:modal:register').setTitle('내 캐릭터 등록').addComponents(...[['name','캐릭터명','도토리검사'],['world','월드','루나'],['job','직업','히어로']].map(([id,label,placeholder])=>row(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30))));
}
export function creationModal() {return new ModalBuilder().setCustomId('mp:modal:create').setTitle('새 파티 만들기').addComponents(row(new TextInputBuilder().setCustomId('name').setLabel('파티 이름').setPlaceholder('목요일 본캐팟').setMaxLength(60).setStyle(TextInputStyle.Short).setRequired(true)));}
export function archiveConfirmation(p) {
  return {content:`**${safe(p.name)}** 파티를 ${p.archived?'복원':'보관'}할까요? 보관한 파티는 다시 복원할 수 있어요.`,embeds:[],components:[row(button(`mp:confirmarchive:${p.id}:${p.version}:${p.archived?'restore':'store'}`,p.archived?'복원하기':'보관하기',ButtonStyle.Primary),button(`mp:detail:${p.id}`,'취소'))],allowedMentions:{parse:[]}};
}

// A shared card is readable by everyone; editing opens a permission-checked personal panel.
export function publicParty(payload,id) {
  return {...payload,components:[row(button(`mp:detail:${id}`,'열기 · 관리'))]};
}
