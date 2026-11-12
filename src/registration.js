import { PermissionFlagsBits } from 'discord.js';

export function inviteUrl(config) {
  const permissions=PermissionFlagsBits.SendMessages|PermissionFlagsBits.ViewChannel|PermissionFlagsBits.SendMessagesInThreads|PermissionFlagsBits.ReadMessageHistory|PermissionFlagsBits.EmbedLinks;
  const url=new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id',config.applicationId);
  url.searchParams.set('scope','bot applications.commands');
  url.searchParams.set('permissions',permissions.toString());
  url.searchParams.set('guild_id',config.guildId);
  return url.href;
}

export function registrationFailure(error) {
  // Only expose numeric API metadata and known network codes, never raw SDK errors.
  const status=Number.isInteger(error?.status)?error.status:null;
  const code=Number.isInteger(error?.code)?error.code:null;
  const networkCodes=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'];
  const network=networkCodes.find(c=>c===error?.code||c===error?.cause?.code);
  let hint='예상하지 못한 오류입니다. 아래 HTTP/API 코드를 확인해 주세요. 토큰이나 .env 내용은 공유하지 마세요.';
  if(code===50001) hint='Missing Access: 대상 서버에서 앱 접근이 허용되지 않았습니다. 초대 링크로 해당 서버에 봇과 applications.commands를 승인하고, 서버 ID 및 토큰과 앱 ID가 같은 앱인지 확인하세요.';
  else if(code===50013) hint='Missing Permissions: 요청에 필요한 권한이 없습니다. 해당 서버의 앱 설치·명령어 승인을 확인하세요. 관리자 권한을 무조건 부여할 필요는 없습니다.';
  else if(code===10002) hint='Unknown Application: Application ID가 올바른지 확인하세요.';
  else if(code===10004) hint='Unknown Guild: 서버 ID가 올바른지 확인하세요. 채널·스레드 ID를 입력하면 안 됩니다.';
  else if(code===50035) hint='Invalid Form Body: 등록할 명령어 정의나 요청 형식이 잘못되었습니다. .env뿐 아니라 commands.js 검토가 필요합니다.';
  else if(status===401) hint='인증 실패: Bot 페이지에서 발급한 현재 봇 토큰인지 확인하세요. 재발급했다면 이전 토큰은 사용할 수 없습니다. Bot 접두어 없이 토큰만 입력하세요.';
  else if(status===403) hint='접근 거부: 토큰과 Application ID가 같은 앱인지, 대상 서버에 앱을 승인했는지 확인하세요.';
  else if(status===429) hint='요청 제한입니다. 잠시 후 다시 시도하세요.';
  else if(status>=500) hint='Discord 서버 오류입니다. 잠시 후 다시 시도하세요.';
  else if(network) hint='네트워크 연결 실패입니다. 인터넷·DNS·프록시 연결을 확인하세요.';
  return `명령어 등록 실패 [HTTP ${status??'없음'} / API ${code??'없음'}${network?` / ${network}`:''}]\n${hint}`;
}
