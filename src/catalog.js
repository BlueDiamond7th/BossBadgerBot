// Initial editable catalog; no price, reward-cycle or party-size assumptions here.
export const BOSSES = [
  { id:'seren', name:'선택받은 세렌', difficulties:['노말','하드','익스트림'] },
  { id:'kalos', name:'감시자 칼로스', difficulties:['이지','노말','카오스','익스트림'] },
  { id:'kaling', name:'카링', difficulties:['이지','노말','하드','익스트림'] },
  { id:'limbo', name:'림보', difficulties:['노말','하드','익스트림'] },
  { id:'blackmage', name:'검은 마법사', difficulties:['하드','익스트림'] },
  { id:'lotus', name:'스우', difficulties:['노말','하드','익스트림'] },
  { id:'damien', name:'데미안', difficulties:['노말','하드'] },
  { id:'will', name:'윌', difficulties:['이지','노말','하드'] }
];
export const bossById = id => BOSSES.find(b=>b.id===id);
