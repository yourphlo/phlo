/* PHLO patient texts: the languages, the text messages, the words on the patient's reply page, and the
 * rules for when to text a patient and how to read their reply.
 * Shared by the web page and the dispatch server: edit here, then run `node scripts/sync-apps-script.js`
 * to copy it to apps-script-dispatch/Texts.gs. Plain global functions on purpose (browser, Apps Script, Node).
 * Translations were written without a native speaker check: have someone who speaks each language read them. */

var PHLO_LANGS = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español (Spanish)' },
  { code: 'zh', name: '简体中文 (Chinese, Simplified)' },
  { code: 'zh-Hant', name: '繁體中文 (Chinese, Traditional)' },
  { code: 'vi', name: 'Tiếng Việt (Vietnamese)' },
  { code: 'ko', name: '한국어 (Korean)' },
  { code: 'tl', name: 'Tagalog' }
];

// What a patient can answer, in the order of the numbers they reply with (1 = redeliver ... 5 = mailbox).
var PHLO_CHOICES = ['redeliver', 'refuse', 'someone', 'door', 'mailbox'];

// How long before the driver arrives the patient gets the "on the way" text (the office can change it).
var PHLO_TEXT_LEAD_MIN = 30;

// Why the office or a pharmacy asks a driver to bring a stop back.
var PHLO_RTS_REASONS = [
  { value: 'pickup', text: 'PT will pick up @ RX instead' },
  { value: 'repack', text: 'RX needs to repack/fill more meds' },
  { value: 'other', text: 'Other' }
];

/* ---------------- text messages (SMS) ---------------- */

var PHLO_SMS = {
  en: {
    eta: 'PHLO pharmacy delivery: your driver is about {min} minutes away (around {time}). Please be home to receive your medications.\n' +
      'Can\'t be home? Reply:\n1 Redeliver another day (add day & time)\n2 I do not want my medications\n3 Someone else will receive (add name & relation)\n4 Leave at front door\n5 Leave in mailbox\n' +
      'Or tap {link}\nReply STOP to stop texts.',
    got_redeliver: 'Thank you. We told your pharmacy to redeliver: {detail}.',
    got_redeliver_ask: 'Thank you. What day and time work for you? Reply like: 1 Friday after 3pm. Or tap {link}',
    got_refuse: 'Thank you. We told your pharmacy you do not want this delivery. Please call your pharmacy with any questions.',
    got_someone: 'Thank you. The driver will give your delivery to: {detail}.',
    got_someone_ask: 'Thank you. Who will receive it? Reply like: 3 Maria, daughter. Or tap {link}',
    got_leave: 'Thank you. Your pharmacy must approve leaving your medications without a signature. We will text you when they answer.',
    approved_door: 'Your pharmacy approved leaving your delivery at the front door without a signature. The driver will take a photo.',
    approved_mailbox: 'Your pharmacy approved leaving your delivery in the mailbox without a signature. The driver will take a photo.',
    declined: 'Your pharmacy needs someone to sign for this delivery. Reply 1 to redeliver another day, or 3 if someone else will be home.',
    unknown: 'Sorry, we did not understand. Reply 1, 2, 3, 4 or 5, or tap {link}',
    closed: 'This delivery is already finished. Please call your pharmacy with any questions.'
  },
  es: {
    eta: 'Entrega de farmacia PHLO: su chofer llegará en unos {min} minutos (alrededor de las {time}). Por favor esté en casa para recibir sus medicamentos.\n' +
      '¿No estará en casa? Responda:\n1 Entregar otro día (agregue día y hora)\n2 No quiero mis medicamentos\n3 Otra persona lo recibirá (agregue nombre y parentesco)\n4 Dejar en la puerta principal\n5 Dejar en el buzón\n' +
      'O toque {link}\nResponda STOP para no recibir más mensajes.',
    got_redeliver: 'Gracias. Le avisamos a su farmacia que entregue otro día: {detail}.',
    got_redeliver_ask: 'Gracias. ¿Qué día y hora le conviene? Responda por ejemplo: 1 viernes después de las 3pm. O toque {link}',
    got_refuse: 'Gracias. Le avisamos a su farmacia que no quiere esta entrega. Llame a su farmacia si tiene preguntas.',
    got_someone: 'Gracias. El chofer entregará su paquete a: {detail}.',
    got_someone_ask: 'Gracias. ¿Quién lo recibirá? Responda por ejemplo: 3 María, hija. O toque {link}',
    got_leave: 'Gracias. Su farmacia debe aprobar que se deje sin firma. Le enviaremos un mensaje cuando respondan.',
    approved_door: 'Su farmacia aprobó dejar su entrega en la puerta principal sin firma. El chofer tomará una foto.',
    approved_mailbox: 'Su farmacia aprobó dejar su entrega en el buzón sin firma. El chofer tomará una foto.',
    declined: 'Su farmacia necesita que alguien firme esta entrega. Responda 1 para entregar otro día, o 3 si otra persona estará en casa.',
    unknown: 'Lo sentimos, no entendimos. Responda 1, 2, 3, 4 o 5, o toque {link}',
    closed: 'Esta entrega ya terminó. Llame a su farmacia si tiene preguntas.'
  },
  zh: {
    eta: 'PHLO药房送货：司机大约{min}分钟后到达（约{time}）。请在家签收您的药品。\n' +
      '不在家？请回复：\n1 改天再送（请写日期和时间）\n2 我不要这些药\n3 由他人代收（请写姓名和关系）\n4 放在前门\n5 放在信箱\n' +
      '或点击 {link}\n回复STOP停止接收短信。',
    got_redeliver: '谢谢。我们已通知您的药房改天再送：{detail}。',
    got_redeliver_ask: '谢谢。哪天什么时间方便？请回复，例如：1 星期五下午3点以后。或点击 {link}',
    got_refuse: '谢谢。我们已通知您的药房您不要这次送货。如有问题请致电您的药房。',
    got_someone: '谢谢。司机会把药交给：{detail}。',
    got_someone_ask: '谢谢。由谁代收？请回复，例如：3 王丽，女儿。或点击 {link}',
    got_leave: '谢谢。不签收放下药品需要您的药房批准。药房回复后我们会发短信通知您。',
    approved_door: '您的药房已批准将药品放在前门，无需签名。司机会拍照。',
    approved_mailbox: '您的药房已批准将药品放在信箱，无需签名。司机会拍照。',
    declined: '您的药房需要有人签收这次送货。请回复1改天再送，或回复3由他人代收。',
    unknown: '抱歉，我们没有看懂。请回复1、2、3、4或5，或点击 {link}',
    closed: '这次送货已经完成。如有问题请致电您的药房。'
  },
  'zh-Hant': {
    eta: 'PHLO藥房送貨：司機大約{min}分鐘後到達（約{time}）。請在家簽收您的藥品。\n' +
      '不在家？請回覆：\n1 改天再送（請寫日期和時間）\n2 我不要這些藥\n3 由他人代收（請寫姓名和關係）\n4 放在前門\n5 放在信箱\n' +
      '或點擊 {link}\n回覆STOP停止接收簡訊。',
    got_redeliver: '謝謝。我們已通知您的藥房改天再送：{detail}。',
    got_redeliver_ask: '謝謝。哪天什麼時間方便？請回覆，例如：1 星期五下午3點以後。或點擊 {link}',
    got_refuse: '謝謝。我們已通知您的藥房您不要這次送貨。如有問題請致電您的藥房。',
    got_someone: '謝謝。司機會把藥交給：{detail}。',
    got_someone_ask: '謝謝。由誰代收？請回覆，例如：3 王麗，女兒。或點擊 {link}',
    got_leave: '謝謝。不簽收放下藥品需要您的藥房批准。藥房回覆後我們會發簡訊通知您。',
    approved_door: '您的藥房已批准將藥品放在前門，無需簽名。司機會拍照。',
    approved_mailbox: '您的藥房已批准將藥品放在信箱，無需簽名。司機會拍照。',
    declined: '您的藥房需要有人簽收這次送貨。請回覆1改天再送，或回覆3由他人代收。',
    unknown: '抱歉，我們沒有看懂。請回覆1、2、3、4或5，或點擊 {link}',
    closed: '這次送貨已經完成。如有問題請致電您的藥房。'
  },
  vi: {
    eta: 'Giao thuốc PHLO: tài xế sẽ đến trong khoảng {min} phút (khoảng {time}). Xin vui lòng ở nhà để nhận thuốc.\n' +
      'Không có nhà? Trả lời:\n1 Giao lại ngày khác (ghi ngày và giờ)\n2 Tôi không muốn nhận thuốc\n3 Người khác sẽ nhận (ghi tên và quan hệ)\n4 Để ở cửa trước\n5 Để trong hộp thư\n' +
      'Hoặc bấm {link}\nTrả lời STOP để ngừng nhận tin nhắn.',
    got_redeliver: 'Cảm ơn. Chúng tôi đã báo nhà thuốc giao lại: {detail}.',
    got_redeliver_ask: 'Cảm ơn. Ngày giờ nào tiện cho quý vị? Trả lời ví dụ: 1 thứ Sáu sau 3 giờ chiều. Hoặc bấm {link}',
    got_refuse: 'Cảm ơn. Chúng tôi đã báo nhà thuốc rằng quý vị không muốn nhận lần giao này. Xin gọi nhà thuốc nếu có thắc mắc.',
    got_someone: 'Cảm ơn. Tài xế sẽ giao cho: {detail}.',
    got_someone_ask: 'Cảm ơn. Ai sẽ nhận? Trả lời ví dụ: 3 Lan, con gái. Hoặc bấm {link}',
    got_leave: 'Cảm ơn. Nhà thuốc phải đồng ý để lại thuốc mà không cần chữ ký. Chúng tôi sẽ nhắn tin khi nhà thuốc trả lời.',
    approved_door: 'Nhà thuốc đã đồng ý để thuốc ở cửa trước, không cần chữ ký. Tài xế sẽ chụp hình.',
    approved_mailbox: 'Nhà thuốc đã đồng ý để thuốc trong hộp thư, không cần chữ ký. Tài xế sẽ chụp hình.',
    declined: 'Nhà thuốc cần có người ký nhận lần giao này. Trả lời 1 để giao lại ngày khác, hoặc 3 nếu có người khác ở nhà.',
    unknown: 'Xin lỗi, chúng tôi không hiểu. Trả lời 1, 2, 3, 4 hoặc 5, hoặc bấm {link}',
    closed: 'Lần giao này đã xong. Xin gọi nhà thuốc nếu có thắc mắc.'
  },
  ko: {
    eta: 'PHLO 약국 배달: 기사님이 약 {min}분 후 도착합니다 ({time}경). 약을 받으실 수 있도록 댁에 계셔 주세요.\n' +
      '댁에 안 계시나요? 답장해 주세요:\n1 다른 날 다시 배달 (날짜와 시간 입력)\n2 약을 받지 않겠습니다\n3 다른 사람이 받습니다 (이름과 관계 입력)\n4 현관문 앞에 놓아 주세요\n5 우편함에 넣어 주세요\n' +
      '또는 {link} 를 누르세요\n문자를 그만 받으시려면 STOP이라고 답장하세요.',
    got_redeliver: '감사합니다. 약국에 다시 배달하도록 알렸습니다: {detail}.',
    got_redeliver_ask: '감사합니다. 언제가 편하신가요? 예: 1 금요일 오후 3시 이후. 또는 {link} 를 누르세요',
    got_refuse: '감사합니다. 이번 배달을 원하지 않으신다고 약국에 알렸습니다. 문의 사항은 약국에 전화해 주세요.',
    got_someone: '감사합니다. 기사님이 다음 분께 전달하겠습니다: {detail}.',
    got_someone_ask: '감사합니다. 누가 받으시나요? 예: 3 김민지, 딸. 또는 {link} 를 누르세요',
    got_leave: '감사합니다. 서명 없이 두고 가려면 약국의 승인이 필요합니다. 약국이 답하면 문자로 알려 드리겠습니다.',
    approved_door: '약국이 서명 없이 현관문 앞에 두는 것을 승인했습니다. 기사님이 사진을 찍습니다.',
    approved_mailbox: '약국이 서명 없이 우편함에 넣는 것을 승인했습니다. 기사님이 사진을 찍습니다.',
    declined: '이번 배달은 누군가 서명해야 한다고 약국이 요청했습니다. 다른 날 배달은 1, 다른 분이 받으시면 3으로 답장해 주세요.',
    unknown: '죄송합니다. 이해하지 못했습니다. 1, 2, 3, 4 또는 5로 답장하시거나 {link} 를 누르세요',
    closed: '이 배달은 이미 끝났습니다. 문의 사항은 약국에 전화해 주세요.'
  },
  tl: {
    eta: 'PHLO pharmacy delivery: ang inyong driver ay mga {min} minuto na lang ang layo (bandang {time}). Paki-antay sa bahay para matanggap ang inyong gamot.\n' +
      'Wala sa bahay? Mag-reply:\n1 Ihatid sa ibang araw (ilagay ang araw at oras)\n2 Ayaw ko ng aking gamot\n3 Ibang tao ang tatanggap (ilagay ang pangalan at relasyon)\n4 Iwan sa harap ng pinto\n5 Iwan sa mailbox\n' +
      'O i-tap ang {link}\nMag-reply ng STOP para itigil ang mga text.',
    got_redeliver: 'Salamat. Sinabihan namin ang inyong botika na ihatid ulit: {detail}.',
    got_redeliver_ask: 'Salamat. Anong araw at oras ang puwede? Mag-reply, halimbawa: 1 Biyernes pagkatapos ng 3pm. O i-tap ang {link}',
    got_refuse: 'Salamat. Sinabihan namin ang inyong botika na ayaw ninyo ng delivery na ito. Tumawag sa inyong botika kung may tanong.',
    got_someone: 'Salamat. Ibibigay ng driver ang inyong delivery kay: {detail}.',
    got_someone_ask: 'Salamat. Sino ang tatanggap? Mag-reply, halimbawa: 3 Maria, anak. O i-tap ang {link}',
    got_leave: 'Salamat. Kailangang aprubahan ng inyong botika na iwan ito nang walang pirma. Ite-text namin kayo kapag sumagot sila.',
    approved_door: 'Inaprubahan ng inyong botika na iwan ang delivery sa harap ng pinto nang walang pirma. Kukuha ng litrato ang driver.',
    approved_mailbox: 'Inaprubahan ng inyong botika na iwan ang delivery sa mailbox nang walang pirma. Kukuha ng litrato ang driver.',
    declined: 'Kailangan ng inyong botika na may pumirma para sa delivery na ito. Mag-reply ng 1 para ihatid sa ibang araw, o 3 kung may ibang tao sa bahay.',
    unknown: 'Paumanhin, hindi namin naintindihan. Mag-reply ng 1, 2, 3, 4 o 5, o i-tap ang {link}',
    closed: 'Tapos na ang delivery na ito. Tumawag sa inyong botika kung may tanong.'
  }
};

/* ---------------- the patient's reply page ---------------- */

var PHLO_PAGE = {
  en: {
    title: 'Your pharmacy delivery', when: 'Delivery on {date}, around {time}.', when_day: 'Delivery on {date}.',
    intro: 'Can\'t be home? Let us know so the driver doesn\'t make a wasted trip.',
    opt_redeliver: 'Not home. Please redeliver another day', opt_refuse: 'I do not want my medications',
    opt_someone: 'Someone else will be home to receive', opt_door: 'Leave at my front door', opt_mailbox: 'Leave in my mailbox',
    leave_note: 'Your pharmacy must approve this first. No signature is needed; the driver takes a photo.',
    f_date: 'Day', f_time: 'Time', t_any: 'Any time', t_morning: 'Morning (9 AM–12 PM)', t_afternoon: 'Afternoon (12–5 PM)', t_evening: 'Evening (5–8 PM)',
    f_name: 'Name', f_relation: 'Relation (for example: daughter)', send: 'Send', back: 'Back',
    st_redeliver: 'You asked us to redeliver: {detail}.', st_refuse: 'You told us you do not want this delivery.',
    st_someone: '{detail} will receive your delivery.', st_door: 'You asked us to leave it at your front door.', st_mailbox: 'You asked us to leave it in your mailbox.',
    ap_pending: 'Waiting for your pharmacy to approve. We will text you.', ap_approved: 'Your pharmacy approved it. The driver will take a photo.',
    ap_declined: 'Your pharmacy needs someone to sign for it. Please pick another choice.',
    change: 'Change my answer', done_delivered: 'This delivery is done.', done_failed: 'The driver could not deliver it. Please call your pharmacy.',
    expired: 'This link has expired. Please call your pharmacy.', error: 'Something went wrong. Please try again.',
    need_date: 'Pick a day.', need_name: 'Type the name of the person.', lang: 'Language', thanks: 'Thank you! Your answer was sent.'
  },
  es: {
    title: 'Su entrega de farmacia', when: 'Entrega el {date}, alrededor de las {time}.', when_day: 'Entrega el {date}.',
    intro: '¿No estará en casa? Avísenos para que el chofer no haga un viaje en vano.',
    opt_redeliver: 'No estaré en casa. Entreguen otro día', opt_refuse: 'No quiero mis medicamentos',
    opt_someone: 'Otra persona estará en casa para recibirlo', opt_door: 'Dejar en mi puerta principal', opt_mailbox: 'Dejar en mi buzón',
    leave_note: 'Su farmacia debe aprobarlo primero. No se necesita firma; el chofer toma una foto.',
    f_date: 'Día', f_time: 'Hora', t_any: 'Cualquier hora', t_morning: 'Mañana (9 AM–12 PM)', t_afternoon: 'Tarde (12–5 PM)', t_evening: 'Noche (5–8 PM)',
    f_name: 'Nombre', f_relation: 'Parentesco (por ejemplo: hija)', send: 'Enviar', back: 'Atrás',
    st_redeliver: 'Pidió que entreguemos otro día: {detail}.', st_refuse: 'Nos dijo que no quiere esta entrega.',
    st_someone: '{detail} recibirá su entrega.', st_door: 'Pidió que lo dejemos en su puerta principal.', st_mailbox: 'Pidió que lo dejemos en su buzón.',
    ap_pending: 'Esperando la aprobación de su farmacia. Le enviaremos un mensaje.', ap_approved: 'Su farmacia lo aprobó. El chofer tomará una foto.',
    ap_declined: 'Su farmacia necesita que alguien firme. Por favor elija otra opción.',
    change: 'Cambiar mi respuesta', done_delivered: 'Esta entrega ya se realizó.', done_failed: 'El chofer no pudo entregarla. Por favor llame a su farmacia.',
    expired: 'Este enlace ya venció. Por favor llame a su farmacia.', error: 'Algo salió mal. Inténtelo de nuevo.',
    need_date: 'Elija un día.', need_name: 'Escriba el nombre de la persona.', lang: 'Idioma', thanks: '¡Gracias! Enviamos su respuesta.'
  },
  zh: {
    title: '您的药房送货', when: '送货日期：{date}，大约{time}。', when_day: '送货日期：{date}。',
    intro: '不在家吗？请告诉我们，以免司机白跑一趟。',
    opt_redeliver: '不在家，请改天再送', opt_refuse: '我不要这些药',
    opt_someone: '有其他人在家代收', opt_door: '放在我家前门', opt_mailbox: '放在我的信箱',
    leave_note: '需要您的药房先批准。无需签名，司机会拍照。',
    f_date: '日期', f_time: '时间', t_any: '任何时间', t_morning: '上午（9点–12点）', t_afternoon: '下午（12点–5点）', t_evening: '晚上（5点–8点）',
    f_name: '姓名', f_relation: '关系（例如：女儿）', send: '发送', back: '返回',
    st_redeliver: '您要求改天再送：{detail}。', st_refuse: '您告诉我们您不要这次送货。',
    st_someone: '{detail}将代收您的药品。', st_door: '您要求放在前门。', st_mailbox: '您要求放在信箱。',
    ap_pending: '正在等待您的药房批准。我们会发短信通知您。', ap_approved: '您的药房已批准。司机会拍照。',
    ap_declined: '您的药房需要有人签收。请选择其他选项。',
    change: '更改我的回答', done_delivered: '这次送货已完成。', done_failed: '司机未能送达。请致电您的药房。',
    expired: '此链接已过期。请致电您的药房。', error: '出了点问题，请再试一次。',
    need_date: '请选择日期。', need_name: '请输入代收人的姓名。', lang: '语言', thanks: '谢谢！您的回答已发送。'
  },
  'zh-Hant': {
    title: '您的藥房送貨', when: '送貨日期：{date}，大約{time}。', when_day: '送貨日期：{date}。',
    intro: '不在家嗎？請告訴我們，以免司機白跑一趟。',
    opt_redeliver: '不在家，請改天再送', opt_refuse: '我不要這些藥',
    opt_someone: '有其他人在家代收', opt_door: '放在我家前門', opt_mailbox: '放在我的信箱',
    leave_note: '需要您的藥房先批准。無需簽名，司機會拍照。',
    f_date: '日期', f_time: '時間', t_any: '任何時間', t_morning: '上午（9點–12點）', t_afternoon: '下午（12點–5點）', t_evening: '晚上（5點–8點）',
    f_name: '姓名', f_relation: '關係（例如：女兒）', send: '發送', back: '返回',
    st_redeliver: '您要求改天再送：{detail}。', st_refuse: '您告訴我們您不要這次送貨。',
    st_someone: '{detail}將代收您的藥品。', st_door: '您要求放在前門。', st_mailbox: '您要求放在信箱。',
    ap_pending: '正在等待您的藥房批准。我們會發簡訊通知您。', ap_approved: '您的藥房已批准。司機會拍照。',
    ap_declined: '您的藥房需要有人簽收。請選擇其他選項。',
    change: '更改我的回答', done_delivered: '這次送貨已完成。', done_failed: '司機未能送達。請致電您的藥房。',
    expired: '此連結已過期。請致電您的藥房。', error: '出了點問題，請再試一次。',
    need_date: '請選擇日期。', need_name: '請輸入代收人的姓名。', lang: '語言', thanks: '謝謝！您的回答已發送。'
  },
  vi: {
    title: 'Đơn giao thuốc của quý vị', when: 'Giao ngày {date}, khoảng {time}.', when_day: 'Giao ngày {date}.',
    intro: 'Không có nhà? Xin cho chúng tôi biết để tài xế không phải đi uổng công.',
    opt_redeliver: 'Không có nhà. Xin giao lại ngày khác', opt_refuse: 'Tôi không muốn nhận thuốc',
    opt_someone: 'Người khác sẽ ở nhà để nhận', opt_door: 'Để ở cửa trước nhà tôi', opt_mailbox: 'Để trong hộp thư của tôi',
    leave_note: 'Nhà thuốc phải đồng ý trước. Không cần chữ ký; tài xế sẽ chụp hình.',
    f_date: 'Ngày', f_time: 'Giờ', t_any: 'Giờ nào cũng được', t_morning: 'Buổi sáng (9 giờ–12 giờ trưa)', t_afternoon: 'Buổi chiều (12–5 giờ chiều)', t_evening: 'Buổi tối (5–8 giờ tối)',
    f_name: 'Tên', f_relation: 'Quan hệ (ví dụ: con gái)', send: 'Gửi', back: 'Trở lại',
    st_redeliver: 'Quý vị yêu cầu giao lại: {detail}.', st_refuse: 'Quý vị cho biết không muốn nhận lần giao này.',
    st_someone: '{detail} sẽ nhận thuốc.', st_door: 'Quý vị yêu cầu để ở cửa trước.', st_mailbox: 'Quý vị yêu cầu để trong hộp thư.',
    ap_pending: 'Đang chờ nhà thuốc đồng ý. Chúng tôi sẽ nhắn tin cho quý vị.', ap_approved: 'Nhà thuốc đã đồng ý. Tài xế sẽ chụp hình.',
    ap_declined: 'Nhà thuốc cần có người ký nhận. Xin chọn cách khác.',
    change: 'Thay đổi câu trả lời', done_delivered: 'Lần giao này đã xong.', done_failed: 'Tài xế không giao được. Xin gọi nhà thuốc.',
    expired: 'Đường dẫn này đã hết hạn. Xin gọi nhà thuốc.', error: 'Có lỗi xảy ra. Xin thử lại.',
    need_date: 'Xin chọn ngày.', need_name: 'Xin ghi tên người nhận.', lang: 'Ngôn ngữ', thanks: 'Cảm ơn! Câu trả lời đã được gửi.'
  },
  ko: {
    title: '약국 배달 안내', when: '배달일: {date}, {time}경.', when_day: '배달일: {date}.',
    intro: '댁에 안 계시나요? 기사님이 헛걸음하지 않도록 알려 주세요.',
    opt_redeliver: '집에 없습니다. 다른 날 다시 배달해 주세요', opt_refuse: '약을 받지 않겠습니다',
    opt_someone: '다른 사람이 집에서 받습니다', opt_door: '현관문 앞에 놓아 주세요', opt_mailbox: '우편함에 넣어 주세요',
    leave_note: '먼저 약국의 승인이 필요합니다. 서명은 필요 없고 기사님이 사진을 찍습니다.',
    f_date: '날짜', f_time: '시간', t_any: '아무 때나', t_morning: '오전 (9시–12시)', t_afternoon: '오후 (12시–5시)', t_evening: '저녁 (5시–8시)',
    f_name: '이름', f_relation: '관계 (예: 딸)', send: '보내기', back: '뒤로',
    st_redeliver: '다시 배달을 요청하셨습니다: {detail}.', st_refuse: '이번 배달을 원하지 않으신다고 알려 주셨습니다.',
    st_someone: '다음 분이 받으십니다: {detail}.', st_door: '현관문 앞에 두도록 요청하셨습니다.', st_mailbox: '우편함에 넣도록 요청하셨습니다.',
    ap_pending: '약국의 승인을 기다리고 있습니다. 문자로 알려 드리겠습니다.', ap_approved: '약국이 승인했습니다. 기사님이 사진을 찍습니다.',
    ap_declined: '약국이 서명이 필요하다고 합니다. 다른 방법을 선택해 주세요.',
    change: '답변 바꾸기', done_delivered: '이 배달은 완료되었습니다.', done_failed: '기사님이 배달하지 못했습니다. 약국에 전화해 주세요.',
    expired: '이 링크는 만료되었습니다. 약국에 전화해 주세요.', error: '문제가 생겼습니다. 다시 시도해 주세요.',
    need_date: '날짜를 선택해 주세요.', need_name: '받으실 분의 이름을 입력해 주세요.', lang: '언어', thanks: '감사합니다! 답변이 전송되었습니다.'
  },
  tl: {
    title: 'Ang inyong pharmacy delivery', when: 'Delivery sa {date}, bandang {time}.', when_day: 'Delivery sa {date}.',
    intro: 'Wala sa bahay? Ipaalam sa amin para hindi masayang ang biyahe ng driver.',
    opt_redeliver: 'Wala ako sa bahay. Ihatid sa ibang araw', opt_refuse: 'Ayaw ko ng aking gamot',
    opt_someone: 'Ibang tao ang nasa bahay para tumanggap', opt_door: 'Iwan sa harap ng aking pinto', opt_mailbox: 'Iwan sa aking mailbox',
    leave_note: 'Kailangan muna itong aprubahan ng inyong botika. Walang pirma na kailangan; kukuha ng litrato ang driver.',
    f_date: 'Araw', f_time: 'Oras', t_any: 'Kahit anong oras', t_morning: 'Umaga (9 AM–12 PM)', t_afternoon: 'Hapon (12–5 PM)', t_evening: 'Gabi (5–8 PM)',
    f_name: 'Pangalan', f_relation: 'Relasyon (halimbawa: anak)', send: 'Ipadala', back: 'Bumalik',
    st_redeliver: 'Humiling kayo na ihatid ulit: {detail}.', st_refuse: 'Sinabi ninyo na ayaw ninyo ng delivery na ito.',
    st_someone: 'Si {detail} ang tatanggap ng inyong delivery.', st_door: 'Humiling kayo na iwan ito sa harap ng pinto.', st_mailbox: 'Humiling kayo na iwan ito sa mailbox.',
    ap_pending: 'Hinihintay ang pag-apruba ng inyong botika. Ite-text namin kayo.', ap_approved: 'Inaprubahan ito ng inyong botika. Kukuha ng litrato ang driver.',
    ap_declined: 'Kailangan ng inyong botika na may pumirma. Pumili ng ibang opsyon.',
    change: 'Baguhin ang aking sagot', done_delivered: 'Tapos na ang delivery na ito.', done_failed: 'Hindi naihatid ng driver. Tumawag sa inyong botika.',
    expired: 'Expired na ang link na ito. Tumawag sa inyong botika.', error: 'May nagkamali. Subukan ulit.',
    need_date: 'Pumili ng araw.', need_name: 'I-type ang pangalan ng tatanggap.', lang: 'Wika', thanks: 'Salamat! Naipadala na ang inyong sagot.'
  }
};

/* ---------------- helpers ---------------- */

/** A known language code, else English. */
function phloLang(code) {
  return PHLO_LANGS.some(function (l) { return l.code === code; }) ? code : 'en';
}

/** Fills {name} slots in a message. */
function phloFill(text, vals) {
  return String(text).replace(/\{(\w+)\}/g, function (m, k) { return vals && vals[k] != null ? String(vals[k]) : m; });
}

/** A text message in the patient's language (English when a translation is missing). */
function phloSms(lang, key, vals) {
  var set = PHLO_SMS[phloLang(lang)];
  return phloFill(set[key] || PHLO_SMS.en[key], vals);
}

/** A phone number as +1XXXXXXXXXX (US numbers) or +<country><number>; '' when it isn't one. */
function phloE164(text) {
  var s = String(text || '').trim();
  var d = s.replace(/\D/g, '');
  if (/^\+/.test(s) && d.length >= 8 && d.length <= 15) return '+' + d;
  if (d.length === 10 && /^[2-9]/.test(d)) return '+1' + d;
  if (d.length === 11 && d.charAt(0) === '1' && /^[2-9]/.test(d.charAt(1))) return '+' + d;
  return '';
}

/** "+16265550100" -> "(626) 555-0100". */
function phloPhoneShow(e164) {
  var m = String(e164 || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : String(e164 || '');
}

/** Minutes after midnight -> "1:05 PM". */
function phloMinClock(m) {
  m = Math.round(m);
  var h = Math.floor(m / 60) % 24, mm = m % 60;
  return ((h % 12) || 12) + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? ' AM' : ' PM');
}

function phloHhmmMin(t) { var p = String(t || '').split(':'); return p.length < 2 ? null : +p[0] * 60 + +p[1]; }

/**
 * Reads a patient's text reply: "1 friday after 3" -> {choice: 'redeliver', detail: 'friday after 3'}.
 * Any reply starting with 1-5 counts (also full-width digits and 一 to 五); anything else is {choice: null, detail: text}.
 */
function phloParseReply(text) {
  var s = String(text || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48); }).trim();
  var cn = '一二三四五'.indexOf(s.charAt(0));
  if (cn >= 0) s = String(cn + 1) + s.slice(1);
  var m = s.match(/^#?\s*([1-5])(?![0-9])[\s.)\-:,，、。]*([\s\S]*)$/);
  if (!m) return { choice: null, detail: s };
  return { choice: PHLO_CHOICES[+m[1] - 1], detail: m[2].replace(/\s+/g, ' ').trim() };
}

/** Does a reply need more from the patient before it is useful (a day for redeliver, a name for someone else)? */
function phloReplyNeedsDetail(choice, detail) {
  return (choice === 'redeliver' || choice === 'someone') && !String(detail || '').trim();
}

var PHLO_TIME_WINDOWS = { any: 'any time', morning: 'morning (9 AM-12 PM)', afternoon: 'afternoon (12-5 PM)', evening: 'evening (5-8 PM)' };

/** English words for a redelivery picked on the reply page: ("2026-10-24", "afternoon") -> "Sat 10/24, afternoon (12-5 PM)". */
function phloRedeliverText(iso, time) {
  var p = String(iso || '').split('-');
  if (p.length !== 3) return '';
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return day + ' ' + (+p[1]) + '/' + (+p[2]) + (time && PHLO_TIME_WINDOWS[time] ? ', ' + PHLO_TIME_WINDOWS[time] : '');
}

/** What a patient asked, in English for the office, the pharmacy and the driver. */
function phloRequestText(req) {
  if (!req || !req.choice) return '';
  var d = String(req.detail || '').trim();
  switch (req.choice) {
    case 'redeliver': return 'Not home: redeliver ' + (d || '(no day given yet)');
    case 'refuse': return 'Does not want the medications';
    case 'someone': return d ? d + ' will receive' : 'Someone else will receive (no name given yet)';
    case 'door': return 'Leave at front door, no signature';
    case 'mailbox': return 'Leave in mailbox, no signature';
  }
  return '';
}

/** Does this answer need the pharmacy's OK (leave it without a signature)? */
function phloNeedsApproval(choice) { return choice === 'door' || choice === 'mailbox'; }

/** "Please RTS to RX [1000001, DOE,JANE]: PT will pick up @ RX instead". */
function phloRtsText(ticket, name, reason, other) {
  var r = PHLO_RTS_REASONS.filter(function (x) { return x.value === reason; })[0];
  var why = reason === 'other' ? String(other || '').trim() : r ? r.text : '';
  return 'Please RTS to RX [' + [ticket, name].filter(Boolean).join(', ') + ']' + (why ? ': ' + why : '');
}

/**
 * Which stops on a route should get the "driver is about N minutes away" text now.
 * route: {start: 'HH:MM', serviceMin, stops: [{id, eta: 'HH:MM'}]} (in route order).
 * done: {stopId: minute of the day the driver recorded it}. startedMin: when the driver started (or null).
 * The driver's delay is how late (or early) they finished their last stop, or started; every stop after it moves
 * by that much. A stop is due when its moved arrival is within leadMin from now (and not more than 15 minutes past).
 * Nothing is due until the driver has started or recorded a stop.
 * Returns [{id, at (minute of the day), min (minutes away, rounded to 5, at least 5)}].
 */
function phloTextDue(route, done, startedMin, nowMin, leadMin) {
  var stops = route.stops || [], service = +route.serviceMin || 0;
  var last = -1, lastAt = -Infinity;
  stops.forEach(function (s, i) { if (done[s.id] != null && done[s.id] >= lastAt) { lastAt = done[s.id]; last = i; } });
  var delay;
  if (last >= 0 && phloHhmmMin(stops[last].eta) != null) delay = lastAt - (phloHhmmMin(stops[last].eta) + service);
  else if (startedMin != null && phloHhmmMin(route.start) != null) delay = startedMin - phloHhmmMin(route.start);
  else return [];
  delay = Math.max(-60, Math.min(300, delay));
  var out = [];
  stops.forEach(function (s, i) {
    if (i <= last || done[s.id] != null) return;
    var eta = phloHhmmMin(s.eta);
    if (eta == null) return;
    var at = eta + delay, away = at - nowMin;
    if (away > leadMin || away < -15) return;
    out.push({ id: s.id, at: Math.round(at), min: Math.max(5, Math.round(away / 5) * 5) });
  });
  return out;
}
