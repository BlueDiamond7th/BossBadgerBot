import { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { BOSSES, DIFFICULTIES } from './catalog.js';

const root=(name,description)=>new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
const partyOption=s=>s.addStringOption(o=>o.setName('파티').setDescription('현재 스레드의 파티').setRequired(true).setAutocomplete(true));
const charOption=s=>s.addStringOption(o=>o.setName('캐릭터').setDescription('현재 스레드의 등록 캐릭터').setRequired(true).setAutocomplete(true));
const bossOption=s=>s.addStringOption(o=>o.setName('보스').setDescription('보스 선택').setRequired(true).addChoices(...BOSSES.map(b=>({name:b.name,value:b.id}))));
export const commands=[
  root('일정','파티 출발 시간·투표·참석 여부를 관리해요')
    .addSubcommand(s=>s.setName('목록').setDescription('현재 채널의 앞으로 7일 보스 일정을 봐요'))
    .addSubcommand(s=>s.setName('내일정').setDescription('내가 포함된 일정과 참석 응답을 봐요'))
    .addSubcommand(s=>partyOption(s.setName('생성').setDescription('시간을 바로 등록하거나 후보 시간을 투표해요'))),
  root('보스방','현재 스레드를 보스 관리 공간으로 사용해요')
    .addSubcommand(s=>s.setName('시작').setDescription('이 스레드에 캐릭터·파티 관리판을 만들어요'))
    .addSubcommand(s=>s.setName('현황').setDescription('현재 스레드의 등록 현황과 관리 버튼을 열어요')),
  root('캐릭터','내 캐릭터를 원하는 만큼 등록하고 관리해요')
    .addSubcommand(s=>s.setName('연결').setDescription('내 API 키를 연결하고 계정 캐릭터를 불러와요'))
    .addSubcommand(s=>s.setName('동기화').setDescription('내 API 키로 캐릭터 목록을 다시 불러와요'))
    .addSubcommand(s=>s.setName('연결해제').setDescription('저장한 내 API 키를 삭제하고 자동 추적을 중단해요'))
    .addSubcommand(s=>charOption(s.setName('스케줄러').setDescription('내 캐릭터의 일일·주간·보스 완료 현황을 봐요')))
    .addSubcommand(s=>charOption(s.setName('스케줄러갱신').setDescription('내 캐릭터의 스케줄러를 API로 갱신해요')))
    .addSubcommand(s=>s.setName('목록').setDescription('스레드 참가자들이 등록한 캐릭터를 봐요')
      .addUserOption(o=>o.setName('등록자').setDescription('선택한 사람의 캐릭터만 보기')))
    .addSubcommand(s=>charOption(s.setName('수정').setDescription('내가 등록한 캐릭터 정보를 수정해요'))
      .addStringOption(o=>o.setName('이름').setDescription('새 캐릭터명').setMaxLength(30)))
    .addSubcommand(s=>charOption(s.setName('스펙').setDescription('수집한 스펙과 장비·스킬 변화를 확인해요')))
    .addSubcommand(s=>charOption(s.setName('스펙갱신').setDescription('내 캐릭터의 월드·직업·스펙을 넥슨 API로 갱신해요')))
    .addSubcommand(s=>charOption(s.setName('환산기록').setDescription('직접 확인한 환산 수치를 날짜별로 기록해요'))
      .addNumberOption(o=>o.setName('수치').setDescription('만 단위가 아닌 표시된 수치 그대로, 예: 65000').setRequired(true).setMinValue(0.01).setMaxValue(1000000000))
      .addStringOption(o=>o.setName('종류').setDescription('환산 종류').setRequired(true).addChoices({name:'환산 주스탯',value:'주스탯'},{name:'헥사 환산',value:'헥사'})))
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
      .addStringOption(o=>o.setName('난이도').setDescription('보스 난이도').setRequired(true).addChoices(...DIFFICULTIES.map(x=>({name:x,value:x})))))
    .addSubcommand(s=>bossOption(partyOption(s.setName('보스제외').setDescription('파티의 등록 보스를 제외해요'))))
    .addSubcommand(s=>partyOption(s.setName('복사').setDescription('구성과 보스를 복사해 내 파티를 만들어요'))
      .addStringOption(o=>o.setName('이름').setDescription('복사한 파티 이름').setMaxLength(60)))
    .addSubcommand(s=>partyOption(s.setName('이름변경').setDescription('파티 이름을 바꿔요'))
      .addStringOption(o=>o.setName('이름').setDescription('새 이름').setMaxLength(60).setRequired(true)))
    .addSubcommand(s=>partyOption(s.setName('보관').setDescription('파티를 보관함으로 옮겨요. 복원할 수 있어요.')))
    .addSubcommand(s=>partyOption(s.setName('복원').setDescription('보관한 파티를 다시 활성화해요'))),
  root('보스기록','주간 보스 클리어 기록을 불러와 저장하고 인원을 편집해요')
    .addSubcommand(s=>charOption(s.setName('히스토리').setDescription('저장한 주차별 보스 기록을 보고, 이번 주·지난주 기록을 불러와 저장해요'))),
  root('결정석','보스 결정석 가격표를 보고 수정해요')
    .addSubcommand(s=>s.setName('가격표').setDescription('현재 서버의 결정석 가격표를 봐요'))
    .addSubcommand(s=>bossOption(s.setName('가격수정').setDescription('보스 결정석 가격을 수정해요'))
      .addStringOption(o=>o.setName('난이도').setDescription('보스 난이도').setRequired(true).addChoices(...DIFFICULTIES.map(x=>({name:x,value:x}))))
      .addStringOption(o=>o.setName('가격').setDescription('예: 4억 6500만 또는 465000000').setRequired(true).setMaxLength(30))),
  root('분배','파티 분배금을 계산하고 기록해요')
    .addSubcommand(s=>partyOption(s.setName('시작').setDescription('분배할 아이템이 있는지 묻고 분배금을 계산해요')))
    .addSubcommand(s=>partyOption(s.setName('목록').setDescription('파티의 분배 기록을 봐요')))
];
export const commandJSON=()=>commands.map(command=>command.toJSON());
