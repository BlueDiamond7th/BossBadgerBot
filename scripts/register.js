import { REST, Routes } from 'discord.js';
import { commandJSON } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { inviteUrl, registrationFailure } from '../src/registration.js';

let config;
try {
  config=loadConfig();
} catch(error) {
  console.error(error.message);
  process.exit(1);
}
console.log('봇 초대 링크:',inviteUrl(config));
if(process.argv.includes('--invite-only')) {
  console.log('위 링크에서 대상 서버에 앱을 승인한 뒤 ./run.command register를 실행하세요.');
} else try {
  const rest=new REST({version:'10',timeout:15000}).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.applicationId,config.guildId),{body:commandJSON()});
  console.log('테스트 서버에 /보스방, /캐릭터, /파티 명령어를 등록했어요.');
} catch(error) {
  // SDK errors can contain request metadata. Avoid printing credentials or raw bodies.
  console.error(registrationFailure(error));
  process.exitCode=1;
}
