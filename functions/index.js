// functions/index.js
// Firebase Cloud Functions의 메인 엔트리 파일입니다.

const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// TODO: 1. 서비스 계정 키 파일을 require하는 대신, 환경 변수에서 JSON 내용을 파싱합니다.
// 'app.service_account_json'은 위에서 새로 설정한 2단계 환경 변수 이름입니다.
// 이전: const serviceAccount = JSON.parse(functions.config().app.service_account_json);
// 수정: functions.config().app.service_account_json이 이미 파싱된 객체일 수 있으므로 JSON.parse()를 제거합니다.
const serviceAccount = functions.config().app.service_account_json; // <-- 이 부분을 수정했습니다!

// Firebase Admin SDK를 초기화합니다.
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const auth = admin.auth();
const db = admin.firestore();

const APP_ID = "ddugi";

const app = express();

app.use(cors({
    origin: ['http://127.0.0.1:5500', 'https://ddugidata.web.app', 'https://YOUR_CUSTOM_DOMAIN.com']
}));
app.use(express.json());

// Gemini API 키를 설정합니다.
// 'gemini.api_key'는 2단계 환경 변수 이름입니다.
const geminiApiKey = functions.config().gemini.api_key;
if (!geminiApiKey) {
    console.error('GEMINI_API_KEY 환경 변수가 Firebase Functions config에 설정되지 않았습니다.');
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

const tugiImageMap = {
    'default': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(2)%20(1).png?alt=media&token=b3754220-4e08-4925-852b-1bb862b9fca5',
    'recommend': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(4).png?alt=media&token=b113ec37-7c12-4b93-96fd-1818ed093f97',
    'thinking': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(Copy).png?alt=media&token=8bef4637-6651-47c0-b5a6-177d810cf9bf',
    'greeting': 'https://placehold.co/100x100/B2F5EA/343A40?text=뚜기_인사',
    'positive': 'https://placehold.co/100x100/C3F7D2/343A40?text=뚜기_긍정',
    'error': 'https://placehold.co/100x100/FF9999/343A40?text=뚜기_에러'
};

const tugiPersona = `
    너는 이제부터 부산 사투리를 쓰는 부산 돼지 캐릭터 '뚜기'야.
    너의 목표는 부산을 방문하는 사람들에게 현지인 맛집과 숨겨진 명소를 추천해주고, 부산 문화에 대해 알려주는 거야.
    말 시작할때는 항상 마! 라고 말해, 약간 센척을 해 상남자처럼 얘기해, 하지만 욕이나 위협은 하지 않아, 대답은 길지않게.
    이전 대화를 기억하고 맥락에 맞춰 답변해줘.
`;

async function getRestaurantsFromFirestore(filters = {}) {
    try {
        let q = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('restaurants');

        if (filters.location) {
            q = q.where('location', '==', filters.location);
        }
        if (filters.type) {
            q = q.where('type', '==', filters.type);
        }

        const querySnapshot = await q.get();
        const restaurants = [];
        querySnapshot.forEach((doc) => {
            restaurants.push({ id: doc.id, ...doc.data() });
        });
        return restaurants;
    } catch (error) {
        console.error('Firestore에서 맛집 데이터를 가져오는 중 오류 발생:', error);
        return [];
    }
}

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    const chatHistory = req.body.history || [];

    if (!userMessage) {
        return res.status(400).json({ error: '메시지를 입력해주세요.' });
    }

    let recommendedRestaurant = null;
    let currentTugiImageKey = 'default';

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const lowerMessage = userMessage.toLowerCase();
        let queryFilters = {};
        if (lowerMessage.includes("해운대")) { queryFilters.location = "해운대"; }
        else if (lowerMessage.includes("영도")) { queryFilters.location = "영도"; }
        else if (lowerMessage.includes("서면")) { queryFilters.location = "서면"; }
        else if (lowerMessage.includes("남포동")) { queryFilters.location = "남포동"; }

        if (lowerMessage.includes("돼지국밥")) { queryFilters.type = "돼지국밥"; }
        else if (lowerMessage.includes("카페")) { queryFilters.type = "카페"; }
        else if (lowerMessage.includes("낙곱새")) { queryFilters.type = "낙곱새"; }
        else if (lowerMessage.includes("밀면")) { queryFilters.type = "밀면"; }
        else if (lowerMessage.includes("횟집")) { queryFilters.type = "횟집"; }

        let restaurants = [];
        if (lowerMessage.includes("맛집") || lowerMessage.includes("추천") || Object.keys(queryFilters).length > 0) {
            restaurants = await getRestaurantsFromFirestore(queryFilters);
        }

        let contextInfo = "";
        if (restaurants.length > 0) {
            recommendedRestaurant = restaurants[Math.floor(Math.random() * restaurants.length)];
            contextInfo = `\n\n[참고할 맛집 정보]:\n- 이름: ${recommendedRestaurant.name}, 위치: ${recommendedRestaurant.location}, 종류: ${recommendedRestaurant.type}, 특징: ${recommendedRestaurant.desc}\n`;
            currentTugiImageKey = 'recommend';
        } else if (lowerMessage.includes("맛집") || lowerMessage.includes("추천")) {
            const allRestaurants = await getRestaurantsFromFirestore({});
            if (allRestaurants.length > 0) {
                recommendedRestaurant = allRestaurants[Math.floor(Math.random() * allRestaurants.length)];
                contextInfo = `\n\n[참고할 맛집 정보]:\n- 이름: ${recommendedRestaurant.name}, 위치: ${recommendedRestaurant.location}, 종류: ${recommendedRestaurant.type}, 특징: ${recommendedRestaurant.desc}\n`;
                currentTugiImageKey = 'recommend';
            } else {
                contextInfo = "\n\n[참고: 현재 데이터베이스에 맛집 정보가 없거나, 요청하신 조건에 맞는 맛집이 없습니다.]\n";
                currentTugiImageKey = 'thinking';
            }
        } else if (lowerMessage.includes("안녕") || lowerMessage.includes("반가워")) {
            currentTugiImageKey = 'greeting';
        } else if (lowerMessage.includes("고마워") || lowerMessage.includes("감사")) {
            currentTugiImageKey = 'positive';
        } else if (lowerMessage.includes("뭐해") || lowerMessage.includes("뭐라노")) {
            currentTugiImageKey = 'thinking';
        }

        const contents = [
            ...chatHistory,
            { role: "user", parts: [{ text: userMessage + contextInfo }] }
        ];

        const result = await model.generateContent({
            system_instruction: { parts: [{ text: tugiPersona }] },
            contents: contents
        });

        const response = await result.response;
        const text = response.text();

        res.json({
            reply: text,
            restaurant: recommendedRestaurant ? {
                name: recommendedRestaurant.name,
                desc: recommendedRestaurant.desc,
                image_url: recommendedRestaurant.image_url,
                location: recommendedRestaurant.location
            } : null,
            tugi_image_url: tugiImageMap[currentTugiImageKey]
        });

    } catch (error) {
        console.error('Gemini API 또는 Firestore 호출 중 오류 발생:', error);
        res.status(500).json({
            error: '뚜기가 잠시 멍 때리고 있심더... 다시 말 걸어주이소.',
            tugi_image_url: tugiImageMap['error']
        });
    }
});

exports.api = functions.https.onRequest(app);
