import { Client, Events, GatewayIntentBits, ActivityType } from 'discord.js';
import { Repository } from './repository.js';
import { PartyService } from './service.js';
import { createHandler } from './interactions.js';
import { createBoardRefresher } from './board.js';
import { loadConfig } from './config.js';
import { PersonalConnections } from './connections.js';
import { SpecTracker } from './specs.js';
import { BossRecords } from './records.js';
import { PriceBook, DistributionBook } from './revenue.js';
import { ScheduleService } from './schedule.js';
import { ScheduleWorker } from './schedule-worker.js';
import { isParticipant, supportedChannel } from './access.js';
import { randomUUID } from 'node:crypto';
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
const schedules=new ScheduleService({repository,service});
const refreshBoard=createBoardRefresher(service,schedules);
const scheduleWorker=new ScheduleWorker({schedules,guildId:config.guildId,getChannel:id=>client.channels.fetch(id),onUpdate:(ctx,channel)=>refreshBoard({channel,id:`schedule-${randomUUID()}`},ctx)});
const connections=new PersonalConnections({repository,service,encryptionKey:config.apiKeyEncryptionKey});
const tracker=new SpecTracker({repository,service,connections});
const records=new BossRecords({repository,service,tracker,connections});
const prices=new PriceBook(repository),distributions=new DistributionBook({repository,service});
const handle=createHandler({service,guildId:config.guildId,tracker,connections,records,prices,distributions,schedules,scheduleWorker,onConnectionChanged:()=>collectSpecs(),refreshBoard});
let specTimer=null,sweepTask=null;
function collectSpecs() {
  if(stopping||sweepTask||!client.isReady()) return;
  tracker.prune();
  if(!connections.vault.configured)return;
  const options={guildId:config.guildId,canCollect:async ctx=>{
    const channel=await client.channels.fetch(ctx.threadId);
    return supportedChannel(channel)&&!channel.archived&&!channel.locked&&await isParticipant(channel,ctx.userId);
  },onUpdate:async ctx=>{
    const channel=await client.channels.fetch(ctx.threadId);
    await refreshBoard({channel,id:`spec-${randomUUID()}`},ctx);
  }};
  sweepTask=(async()=>{await connections.sweep(options);if(!stopping)await tracker.sweep(options);})()
    .catch(()=>console.warn('[spec-sync] FAILED')).finally(()=>{sweepTask=null;});
}
client.once(Events.ClientReady,ready=>{
  if(ready.application.id!==config.applicationId) {console.error('DISCORD_TOKEN과 DISCORD_APPLICATION_ID가 같은 앱의 값인지 확인해 주세요.');client.destroy();repository.close();process.exitCode=1;return;}
  console.log('봇 연결 완료. 스레드에서 /보스방 시작을 실행하세요.');
  collectSpecs();specTimer=setInterval(collectSpecs,3600_000);specTimer.unref();
  void scheduleWorker.start().catch(()=>console.warn('[schedule] start-failed'));
  ready.user.setActivity('/보스방 시작',{type:ActivityType.Listening});
});
client.on(Events.InteractionCreate,interaction=>{void handle(interaction).catch(error=>console.error('[handler]',error.code??error.name));});
client.on(Events.Error,error=>console.error('[discord]',error.code??error.name));
let stopping=false;
async function stop() {if(stopping)return;stopping=true;clearInterval(heartbeat);clearInterval(specTimer);connections.close();await scheduleWorker.stop();await tracker.stop();await sweepTask;if(healthFile)rmSync(healthFile,{force:true});await client.destroy();repository.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
try {await client.login(config.token);} catch(error) {console.error('봇 로그인 실패. 토큰·네트워크 설정을 확인해 주세요.',error.code??error.name);await stop();process.exitCode=1;}
