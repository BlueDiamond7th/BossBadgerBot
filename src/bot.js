import { Client, Events, GatewayIntentBits, ActivityType } from 'discord.js';
import { Repository } from './repository.js';
import { PartyService } from './service.js';
import { createHandler } from './interactions.js';
import { createBoardRefresher } from './board.js';
import { loadConfig } from './config.js';
import { writeFileSync, rmSync } from 'node:fs';

let config;
try {config=loadConfig();} catch(error) {console.error(error.message);process.exit(1);}
const repository=new Repository(config.databasePath);
repository.pruneReceipts();
const service=new PartyService(repository);
const client=new Client({intents:[GatewayIntentBits.Guilds],allowedMentions:{parse:[]},rest:{timeout:15_000}});
const healthFile=process.env.HEALTH_FILE;
if(healthFile) rmSync(healthFile,{force:true});
const heartbeat=healthFile?setInterval(()=>{
  if(client.isReady()) writeFileSync(healthFile,'ready');
  else rmSync(healthFile,{force:true});
},5000):null;
heartbeat?.unref();
const handle=createHandler({service,guildId:config.guildId,refreshBoard:createBoardRefresher(service)});
client.once(Events.ClientReady,ready=>{
  if(ready.application.id!==config.applicationId) {console.error('DISCORD_TOKEN과 DISCORD_APPLICATION_ID가 같은 앱의 값인지 확인해 주세요.');client.destroy();repository.close();process.exitCode=1;return;}
  console.log('봇 연결 완료. 스레드에서 /보스방 시작을 실행하세요.');
  ready.user.setActivity('/보스방 시작',{type:ActivityType.Listening});
});
client.on(Events.InteractionCreate,interaction=>{void handle(interaction).catch(error=>console.error('[handler]',error.code??error.name));});
client.on(Events.Error,error=>console.error('[discord]',error.code??error.name));
let stopping=false;
async function stop() {if(stopping)return;stopping=true;clearInterval(heartbeat);if(healthFile)rmSync(healthFile,{force:true});await client.destroy();repository.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
try {await client.login(config.token);} catch(error) {console.error('봇 로그인 실패. 토큰·네트워크 설정을 확인해 주세요.',error.code??error.name);await stop();process.exitCode=1;}
