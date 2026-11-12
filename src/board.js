import { board } from './views.js';

// Serialize refreshes per thread and read the latest DB state inside the queue.
export function createBoardRefresher(service) {
  const queues=new Map();
  return async (i,ctx)=>{
    const key=`${ctx.guildId}:${ctx.threadId}`;
    const prior=queues.get(key)??Promise.resolve();
    const current=prior.catch(()=>{}).then(async()=>{
      const state=service.snapshot(ctx),payload=board(state),channel=i.channel;
      if(channel.joinable) await channel.join();
      if(state.boardMessageId) {
        try {const message=await channel.messages.fetch(state.boardMessageId);await message.edit(payload);return;}
        catch(error) {if(error.code!==10008) throw error;}
      }
      const sent=await channel.send(payload);
      service.setBoard(ctx,sent.id,`${i.id}:board`);
    });
    queues.set(key,current);
    try {await current;} finally {if(queues.get(key)===current) queues.delete(key);}
  };
}
