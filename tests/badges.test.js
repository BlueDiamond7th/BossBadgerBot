import test from 'node:test';
import assert from 'node:assert/strict';
import { bossBadge, ansiBlock } from '../src/views.js';

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
