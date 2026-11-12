export function loadConfig(env=process.env) {
  const missing=['DISCORD_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID'].filter(key=>!env[key]?.trim());
  if(missing.length) throw new Error(`.env에 다음 값을 설정해 주세요: ${missing.join(', ')}`);
  for(const key of ['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID']) if(!/^\d{17,20}$/.test(env[key])) throw new Error(`${key}는 디스코드에서 복사한 숫자 ID여야 해요.`);
  if(env.API_KEY_ENCRYPTION_KEY?.trim()&&!/^[A-Za-z0-9+/]{43}=$/.test(env.API_KEY_ENCRYPTION_KEY.trim())) throw new Error('API_KEY_ENCRYPTION_KEY는 32바이트 무작위 값을 base64로 인코딩한 문자열이어야 해요.');
  return {apiKeyEncryptionKey:env.API_KEY_ENCRYPTION_KEY?.trim()||'',token:env.DISCORD_TOKEN.trim(),applicationId:env.DISCORD_APPLICATION_ID,guildId:env.DISCORD_GUILD_ID,databasePath:env.DATABASE_PATH?.trim()||'./data/bot.sqlite'};
}
