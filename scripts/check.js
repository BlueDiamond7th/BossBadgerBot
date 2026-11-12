import { commandJSON } from '../src/commands.js';
import { board, creationModal, registrationModal } from '../src/views.js';
import { loadConfig } from '../src/config.js';
const data=commandJSON();
if(data.length!==3) throw new Error('명령어 정의를 확인해 주세요.');
board({characters:[],parties:[]}).embeds.forEach(e=>e.toJSON());
creationModal().toJSON();registrationModal().toJSON();
console.log('명령어·Discord UI 스키마 확인 완료.');
try {loadConfig();console.log('실행 설정이 있어요. 실제 연결은 start에서 확인해요.');}
catch(error) {console.log(`실제 연결 전 설정 필요: ${error.message}`);}
