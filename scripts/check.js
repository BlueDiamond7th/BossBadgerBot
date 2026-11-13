import { commandJSON } from '../src/commands.js';
import { board, creationModal, registrationModal, distModal, priceTable } from '../src/views.js';
import { DEFAULT_CRYSTAL_PRICES } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { scheduleInputModal, scheduleEditModal, scheduleReasonModal, scheduleList } from '../src/schedule-views.js';
const data=commandJSON();
if(data.length!==7) throw new Error('명령어 정의를 확인해 주세요.');
board({characters:[],parties:[]}).embeds.forEach(e=>e.toJSON());
creationModal().toJSON();registrationModal().toJSON();distModal('mp:modal:dist:x:1').toJSON();
priceTable({prices:DEFAULT_CRYSTAL_PRICES,overrides:new Set()}).embeds.forEach(e=>e.toJSON());
scheduleInputModal('p','fixed').toJSON();scheduleInputModal('p','poll').toJSON();
scheduleEditModal({id:'s',startAt:Date.now()+3600_000,duration:60,version:1}).toJSON();
scheduleReasonModal('confirm','s',1,'candidate').toJSON();
scheduleList([]).components.forEach(r=>r.toJSON());
console.log('명령어·Discord UI 스키마 확인 완료.');
try {const config=loadConfig();console.log('실행 설정이 있어요. 실제 연결은 start에서 확인해요.');console.log(config.apiKeyEncryptionKey?'개인 API 키 암호화 설정이 있어요.':'개인 API 연결을 사용하려면 API_KEY_ENCRYPTION_KEY를 설정해 주세요.');}
catch(error) {console.log(`실제 연결 전 설정 필요: ${error.message}`);}
