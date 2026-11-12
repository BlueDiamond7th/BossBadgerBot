import { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { BOSSES } from './catalog.js';

const root=(name,description)=>new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
const partyOption=s=>s.addStringOption(o=>o.setName('파티').setDescription('현재 스레드의 파티').setRequired(true).setAutocomplete(true));
const charOption=s=>s.addStringOption(o=>o.setName('캐릭터').setDescription('현재 스레드의 등록 캐릭터').setRequired(true).setAutocomplete(true));
const bossOption=s=>s.addStringOption(o=>o.setName('보스').setDescription('보스 선택').setRequired(true).addChoices(...BOSSES.map(b=>({name:b.name,value:b.id}))));
export const commands=[
  root('보스방','현재 스레드를 보스 관리 공간으로 사용해요')
    .addSubcommand(s=>s.setName('시작').setDescription('이 스레드에 캐릭터·파티 관리판을 만들어요'))
    .addSubcommand(s=>s.setName('현황').setDescription('현재 스레드의 등록 현황과 관리 버튼을 열어요')),
  root('캐릭터','내 캐릭터를 원하는 만큼 등록하고 관리해요')
    .addSubcommand(s=>s.setName('등록').setDescription('이 스레드에서 사용할 내 캐릭터를 등록해요')
      .addStringOption(o=>o.setName('이름').setDescription('캐릭터 닉네임').setMaxLength(30).setRequired(true))
      .addStringOption(o=>o.setName('월드').setDescription('예: 루나').setMaxLength(30).setRequired(true))
      .addStringOption(o=>o.setName('직업').setDescription('예: 히어로').setMaxLength(30).setRequired(true)))
    .addSubcommand(s=>s.setName('목록').setDescription('스레드 참가자들이 등록한 캐릭터를 봐요')
      .addUserOption(o=>o.setName('등록자').setDescription('선택한 사람의 캐릭터만 보기')))
    .addSubcommand(s=>charOption(s.setName('수정').setDescription('내가 등록한 캐릭터 정보를 수정해요'))
      .addStringOption(o=>o.setName('이름').setDescription('새 캐릭터명').setMaxLength(30))
      .addStringOption(o=>o.setName('월드').setDescription('새 월드').setMaxLength(30))
      .addStringOption(o=>o.setName('직업').setDescription('새 직업').setMaxLength(30)))
    .addSubcommand(s=>charOption(s.setName('해제').setDescription('내 캐릭터 등록을 해제해요. 편성 중이면 먼저 제외해 주세요.'))),
  root('파티','등록된 캐릭터로 파티를 만들고 보스를 정해요')
    .addSubcommand(s=>s.setName('생성').setDescription('현재 스레드에 새 파티를 만들어요')
      .addStringOption(o=>o.setName('이름').setDescription('파티 이름').setMaxLength(60).setRequired(true)))
    .addSubcommand(s=>s.setName('목록').setDescription('현재 스레드의 파티 목록을 열어요')
      .addBooleanOption(o=>o.setName('보관함').setDescription('보관한 파티 보기')))
    .addSubcommand(s=>partyOption(s.setName('정보').setDescription('파티 구성과 보스를 확인하고 편집해요')))
    .addSubcommand(s=>charOption(partyOption(s.setName('캐릭터추가').setDescription('스레드의 등록 캐릭터를 편성해요'))))
    .addSubcommand(s=>charOption(partyOption(s.setName('캐릭터제외').setDescription('편성한 캐릭터를 파티에서 제외해요'))))
    .addSubcommand(s=>bossOption(partyOption(s.setName('보스추가').setDescription('파티에 보스와 난이도를 등록해요')))
      .addStringOption(o=>o.setName('난이도').setDescription('보스 난이도').setRequired(true).addChoices(...['이지','노말','하드','카오스','익스트림'].map(x=>({name:x,value:x})))))
    .addSubcommand(s=>bossOption(partyOption(s.setName('보스제외').setDescription('파티의 등록 보스를 제외해요'))))
    .addSubcommand(s=>partyOption(s.setName('복사').setDescription('구성과 보스를 복사해 내 파티를 만들어요'))
      .addStringOption(o=>o.setName('이름').setDescription('복사한 파티 이름').setMaxLength(60)))
    .addSubcommand(s=>partyOption(s.setName('이름변경').setDescription('파티 이름을 바꿔요'))
      .addStringOption(o=>o.setName('이름').setDescription('새 이름').setMaxLength(60).setRequired(true)))
    .addSubcommand(s=>partyOption(s.setName('보관').setDescription('파티를 보관함으로 옮겨요. 복원할 수 있어요.')))
    .addSubcommand(s=>partyOption(s.setName('복원').setDescription('보관한 파티를 다시 활성화해요')))
];
export const commandJSON=()=>commands.map(command=>command.toJSON());
