// functions/index.js
// Cloud Functions 2세대 HTTP 함수의 예시입니다.

// 필요한 모듈을 임포트합니다.
// 'functions' 객체는 functions.config()를 위해 필요합니다.
const functions = require('firebase-functions');
// onRequest는 Cloud Functions 2세대에서 HTTP 요청을 처리하는 방식입니다.
const { onRequest } = require('firebase-functions/v2/https');
// setGlobalOptions는 함수에 대한 전역 설정을 지정할 때 사용됩니다.
const { setGlobalOptions } = require('firebase-functions/v2');

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// Firebase Admin SDK 초기화는 함수가 호출될 때 한 번만 수행되도록 합니다.
let initializedAdminApp = null;
function getInitializedAdminApp() {
  if (!initializedAdminApp) {
    // 환경 변수에서 서비스 계정 JSON 문자열을 가져와 파싱합니다.
    // functions.config()는 'firebase functions:config:set'으로 설정된 값을 읽습니다.
    // 'app.service_account_json'은 이전에 설정한 2단계 환경 변수 이름입니다.
    const serviceAccount = JSON.parse(functions.config().app.service_account_json); // <-- 이 부분 수정
    initializedAdminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return initializedAdminApp;
}

// Firestore 및 Auth 인스턴스 가져오기
function getDb() { return admin.firestore(getInitializedAdminApp()); }
function getAuth() { return admin.auth(getInitializedAdminApp()); }

// TODO: Firestore 컬렉션 경로에 사용할 앱 ID를 정의합니다.
const APP_ID = "ddugi";

const app = express();
// CORS 설정: 프론트엔드 도메인을 허용합니다.
// TODO: 'https://YOUR_PROJECT_ID.web.app', 'https://YOUR_CUSTOM_DOMAIN.com'을 실제 URL로 교체
app.use(cors({ origin: ['http://127.0.0.1:5500', 'https://ddugidata.web.app', 'https://YOUR_CUSTOM_DOMAIN.com'] }));
app.use(express.json());

// Gemini API 키를 환경 변수에서 가져옵니다.
// 'gemini.api_key'는 이전에 설정한 2단계 환경 변수 이름입니다.
let genAIInstance = null;
function getGenAI() {
  if (!genAIInstance) {
    const geminiApiKey = functions.config().gemini.api_key; // <-- 이 부분 수정
    if (!geminiApiKey) {
        console.error('GEMINI_API_KEY 환경 변수가 설정되지 않았습니다!');
        throw new Error('Gemini API Key is not configured.');
    }
    genAIInstance = new GoogleGenerativeAI(geminiApiKey);
  }
  return genAIInstance;
}

// TODO: 이 함수는 Cloud Functions 2세대에서 전역 옵션을 설정하는 방식입니다.
// 필요한 경우 주석을 해제하고 리전을 설정하세요.
// setGlobalOptions({ region: 'us-central1' }); // 또는 'asia-northeast3' (서울)

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
        const dbInstance = getDb(); // 초기화된 db 인스턴스 사용
        let q = dbInstance.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('restaurants');

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
        const genAI = getGenAI(); // 초기화된 GenAI 인스턴스 사용
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

exports.api = onRequest(app);
