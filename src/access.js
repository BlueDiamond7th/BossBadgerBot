import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { requireRule, DomainError } from './errors.js';

export async function isThreadMember(channel,userId) {
  try { await channel.members.fetch({member:userId,force:true,cache:false});return true; }
  catch(error) { if(error.status===404||error.code===10007||error.code===10013) return false;throw error; }
}
export const supportedChannel=channel=>Boolean(channel?.isThread()||channel?.type===ChannelType.GuildText);
export async function isParticipant(channel,userId) {
  if(channel.isThread()) return isThreadMember(channel,userId);
  try {
    const member=await channel.guild.members.fetch({user:userId,force:true,cache:false});
    return channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages])??false;
  } catch(error) {if(error.status===404||error.code===10007||error.code===10013) return false;throw error;}
}
export async function contextFor(interaction,guildId) {
  requireRule(interaction.inGuild()&&interaction.guildId===guildId,'설정한 디스코드 서버 안에서 사용해 주세요.','FORBIDDEN');
  const channel=interaction.channel;
  requireRule(supportedChannel(channel),'일반 텍스트 채널 또는 스레드에서 사용해 주세요.','NOT_CHANNEL');
  requireRule(!channel.archived&&!channel.locked,'보관·잠금 해제한 스레드에서 사용해 주세요.','LOCKED');
  requireRule(await isParticipant(channel,interaction.user.id),'채널 보기·메시지 보내기 권한 또는 스레드 참가 상태를 확인해 주세요.','NOT_MEMBER');
  return {guildId:interaction.guildId,threadId:channel.id,userId:interaction.user.id,isManager:interaction.memberPermissions?.has(channel.isThread()?PermissionFlagsBits.ManageThreads:PermissionFlagsBits.ManageChannels)??false};
}
export async function eligibleOwners(channel,ids) {
  const users=[...new Set(ids)],result=new Set();
  // Bounded concurrency and authoritative fetches; no cached membership grant.
  for(let offset=0;offset<users.length;offset+=4) {
    await Promise.all(users.slice(offset,offset+4).map(async id=>{if(await isParticipant(channel,id)) result.add(id);}));
  }
  return result;
}
export function requireEditable(ctx,p,version=null) {
  requireRule(p.creatorId===ctx.userId||ctx.isManager,'파티 생성자 또는 해당 채널/스레드 관리 권한이 있는 사람만 편집할 수 있어요.','FORBIDDEN');
  if(version!==null) requireRule(p.version===version,'파티가 변경됐어요. 파티 정보를 다시 열어 주세요.','STALE');
  return p;
}
export const visibleError=error=>error instanceof DomainError?error.message:'디스코드 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요. 저장된 내용은 다시 조회할 수 있어요.';
