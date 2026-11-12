export function loadConfig(env=process.env) {
  const missing=['DISCORD_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID'].filter(key=>!env[key]?.trim());
  if(missing.length) throw new Error(`.env에 다음 값을 설정해 주세요: ${missing.join(', ')}`);
  for(const key of ['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID']) if(!/^\d{17,20}$/.test(env[key])) throw new Error(`${key}는 디스코드에서 복사한 숫자 ID여야 해요.`);
  return {token:env.DISCORD_TOKEN.trim(),applicationId:env.DISCORD_APPLICATION_ID,guildId:env.DISCORD_GUILD_ID,databasePath:env.DATABASE_PATH?.trim()||'./data/bot.sqlite'};
}
