import test from 'node:test';
import assert from 'node:assert/strict';
import { bossBadge, ansiBlock, ansiChunks, priceTable } from '../src/views.js';
import { DEFAULT_CRYSTAL_PRICES } from '../src/catalog.js';

const E='\u001b[';
test('difficulty badges use the requested ANSI colours and line up boss names',()=>{
  assert.equal(bossBadge('이지','벨로나'),`${E}1;37m  EASY  ${E}0m  ${E}1;37m벨로나${E}0m`);
  assert.equal(bossBadge('노말','발드릭스'),`${E}1;44m NORMAL ${E}0m  ${E}1;37m발드릭스${E}0m`);
  assert.equal(bossBadge('하드','최초의 대적자'),`${E}1;45m  HARD  ${E}0m  ${E}1;37m최초의 대적자${E}0m`);
  assert.equal(bossBadge('카오스','감시자 칼로스'),`${E}1;33;40m  CHAOS  ${E}0m ${E}1;37m감시자 칼로스${E}0m`);
  assert.equal(bossBadge('익스트림','스우'),`${E}1;31;40m EXTREME ${E}0m ${E}1;37m스우${E}0m`);
  // Every name starts at the same column once colour codes are removed.
  const columns=['이지','노말','하드','카오스','익스트림'].map(d=>bossBadge(d,'보스').replace(/\u001b\[[\d;]*m/g,'').indexOf('보스'));
  assert.deepEqual(new Set(columns).size,1);
  // Backticks cannot close the code block early.
  assert.ok(!bossBadge('하드','a`b').includes('`'));
});
test('ansi blocks stay within the size limit and stay closed',()=>{
  const lines=Array.from({length:40},(_,i)=>`${i}. ${bossBadge('하드','최초의 대적자')} · 13억 9,000만 메소`);
  const out=ansiBlock(lines,1024);
  assert.ok(out.length<=1024);assert.ok(out.startsWith('```ansi\n'));assert.ok(out.endsWith('\n```'));
  assert.match(out,/… 외 \d+개\n```$/);
  assert.equal(ansiBlock(lines.slice(0,2)).split('\n').length,4);
});

const rows=embed=>embed.fields.flatMap(f=>{assert.ok(f.value.length<=1024);assert.match(f.value,/^```ansi\n[\s\S]*\n```$/);return f.value.slice(8,-4).split('\n');});
const clean=l=>l.replace(/\u001b\[[\d;]*m/g,'').replace(/\s+/g,' ').trim();
test('crystal price table uses the same badges, one line per difficulty, cheapest first',()=>{
  const prices={...DEFAULT_CRYSTAL_PRICES,'kalos:카오스':1_250_000_000};
  const embed=priceTable({prices,overrides:new Set(['kalos:카오스'])}).embeds[0].toJSON();
  const lines=rows(embed);
  assert.equal(lines.length,39);assert.ok(JSON.stringify(embed).length<6000);
  assert.equal(lines[0],`${bossBadge('하드','데미안')} · 4,640만 메소 · 6인`);
  assert.equal(clean(lines.at(-1)),'EXTREME 발드릭스 · 96억 메소 · 3인');
  const values=lines.map(l=>clean(l));
  assert.ok(values.includes('CHAOS 감시자 칼로스 · 12억 5,000만 메소 · 6인 ✏️'));
  assert.ok(values.includes('EXTREME 스우 · 5억 4,500만 메소 · 2인'));
  assert.ok(values.includes('EXTREME 검은 마법사 · 56억 8,000만 메소 · 6인 · 월간'));
  // Cheapest first: parse "N억 N만" back to meso and check the order.
  const meso=l=>{const t=clean(l).split(' · ')[1].replace(/[, 메소]/g,'');const e=t.match(/(\d+)억/),m=t.match(/(\d+)만/);return (e?+e[1]*1e8:0)+(m?+m[1]*1e4:0);};
  const amounts=lines.map(meso);assert.deepEqual(amounts,[...amounts].sort((a,b)=>a-b));
  assert.match(embed.fields[0].name,/^가격표 1\/\d$/);
});
test('ansi chunks never split a line and keep every chunk closed',()=>{
  const lines=Array.from({length:30},(_,i)=>`${String(i).padStart(2)} ${'가'.repeat(40)}`);
  const chunks=ansiChunks(lines,300);
  assert.ok(chunks.length>1);
  assert.deepEqual(chunks.flatMap(c=>{assert.ok(c.length<=300);return c.slice(8,-4).split('\n');}),lines);
});
