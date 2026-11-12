import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteUrl, registrationFailure } from '../src/registration.js';

test('invite contains guild authorization scopes without a credential',()=>{
  const url=new URL(inviteUrl({applicationId:'123456789012345678',guildId:'223456789012345678',token:'SECRET'}));
  assert.equal(url.searchParams.get('scope'),'bot applications.commands');
  assert.equal(url.searchParams.get('guild_id'),'223456789012345678');
  assert.ok(!url.href.includes('SECRET'));
});

test('registration diagnostics distinguish access, authentication and network failures without raw data',()=>{
  const raw={message:'SECRET',requestBody:{token:'SECRET'},stack:'SECRET'};
  for(const [error,expected] of [
    [{status:403,code:50001},/Missing Access/],
    [{status:401,code:0},/인증 실패/],
    [{status:400,code:50035},/Invalid Form Body/],
    [{cause:{code:'ENOTFOUND'}},/네트워크 연결 실패/],
    [{code:'SECRET'},/예상하지 못한 오류/],
  ]) {
    const result=registrationFailure({...raw,...error});
    assert.match(result,expected);
    assert.ok(!result.includes('SECRET'));
  }
});
