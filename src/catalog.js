// Editable boss catalog. Crystal prices are initial defaults; each server can override them with /결정석 가격수정.
// maxParty is the divisor cap for crystal revenue; partyLimits overrides it per difficulty.
export const BOSSES = [
  { id:'lotus', name:'스우', difficulties:['노말','하드','익스트림'], maxParty:6, partyLimits:{'익스트림':2} },
  { id:'damien', name:'데미안', difficulties:['노말','하드'], maxParty:6 },
  { id:'slime', name:'가디언 엔젤 슬라임', difficulties:['노말','카오스'], maxParty:6 },
  { id:'lucid', name:'루시드', difficulties:['이지','노말','하드'], maxParty:6 },
  { id:'will', name:'윌', difficulties:['이지','노말','하드'], maxParty:6 },
  { id:'dusk', name:'더스크', difficulties:['노말','카오스'], maxParty:6 },
  { id:'jinhilla', name:'진 힐라', difficulties:['노말','하드'], maxParty:6 },
  { id:'darknell', name:'듄켈', difficulties:['노말','하드'], maxParty:6 },
  { id:'blackmage', name:'검은 마법사', difficulties:['하드','익스트림'], maxParty:6, monthly:true },
  { id:'seren', name:'선택받은 세렌', difficulties:['노말','하드','익스트림'], maxParty:6 },
  { id:'kalos', name:'감시자 칼로스', difficulties:['이지','노말','카오스','익스트림'], maxParty:6 },
  { id:'adversary', name:'최초의 대적자', difficulties:['이지','노말','하드','익스트림'], maxParty:3 },
  { id:'kaling', name:'카링', difficulties:['이지','노말','하드','익스트림'], maxParty:6 },
  { id:'star', name:'찬란한 흉성', difficulties:['노말','하드'], maxParty:3 },
  { id:'limbo', name:'림보', difficulties:['노말','하드','익스트림'], maxParty:3 },
  { id:'baldrix', name:'발드릭스', difficulties:['노말','하드','익스트림'], maxParty:3 },
  { id:'jupiter', name:'유피테르', difficulties:['노말','하드'], maxParty:3 },
  { id:'bellona', name:'벨로나', difficulties:['이지','노말','하드'], maxParty:3 },
];
export const bossById = id => BOSSES.find(b=>b.id===id);
export const partyLimit = (boss,difficulty) => boss.partyLimits?.[difficulty] ?? boss.maxParty;
export const DIFFICULTIES = ['이지','노말','하드','카오스','익스트림'];

const 억=100_000_000, 만=10_000;
// Unit: meso. Bosses at or below 노말 진 힐라 have no price and are assumed to be soloed.
export const DEFAULT_CRYSTAL_PRICES = {
  'lotus:하드':4890*만, 'damien:하드':4640*만, 'lucid:하드':5970*만, 'will:하드':7320*만,
  'dusk:카오스':6630*만, 'slime:카오스':7130*만, 'darknell:하드':8960*만, 'jinhilla:하드':1*억,
  'blackmage:하드':4*억+6500*만,
  'seren:노말':1*억+6700*만, 'kalos:이지':2*억+3800*만, 'adversary:이지':2*억+6100*만, 'seren:하드':3*억+200*만, 'kaling:이지':3*억+2000*만,
  'bellona:이지':3*억+9600*만, 'kalos:노말':4*억+7900*만, 'adversary:노말':5*억+3200*만, 'lotus:익스트림':5*억+4500*만, 'star:노말':5*억+7600*만, 'kaling:노말':5*억+9300*만,
  'bellona:노말':8*억+2400*만, 'limbo:노말':9*억+9500*만, 'kalos:카오스':12*억+3000*만, 'baldrix:노말':13*억+2000*만, 'adversary:하드':13*억+9000*만,
  'jupiter:노말':15*억+6000*만, 'kaling:하드':15*억+6000*만, 'seren:익스트림':18*억+4000*만, 'blackmage:익스트림':56*억+8000*만,
  'limbo:하드':23*억+8500*만, 'star:하드':26*억+7800*만, 'bellona:하드':29*억+5000*만, 'baldrix:하드':30*억+7800*만,
  'kalos:익스트림':41*억+400*만, 'adversary:익스트림':47*억+1200*만, 'kaling:익스트림':48*억+4500*만, 'jupiter:하드':53*억+8700*만,
  'limbo:익스트림':75*억, 'baldrix:익스트림':96*억,
};
export const priceKey=(bossId,difficulty)=>`${bossId}:${difficulty}`;

// NEXON scheduler API names and English difficulty codes.
const SCHEDULER_DIFFICULTY={easy:'이지',normal:'노말',hard:'하드',chaos:'카오스',extreme:'익스트림'};
export function fromScheduler(contentName,difficulty) {
  const boss=BOSSES.find(b=>b.name===contentName);
  return {boss:boss??null,difficulty:SCHEDULER_DIFFICULTY[difficulty]??difficulty};
}
