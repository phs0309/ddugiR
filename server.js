// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { initializeApp } = require('firebase/app');
const { getFirestore, collection, query, where, getDocs } = require('firebase/firestore');

const app = express();
const port = 3000;

// --- Firebase Configuration Object ---
// TODO: Replace YOUR_FIREBASE_CONFIG with your actual configuration object copied from the Firebase console.
const firebaseConfig = {
    apiKey: "AIzaSyBJB2J1aiOGyv2cVWouXxi2PYNiTQr5tzw",
    authDomain: "ddugidata.firebaseapp.com",
    projectId: "ddugidata",
    storageBucket: "ddugidata.firebasestorage.app",
    messagingSenderId: "399848511872",
    appId: "1:399848511872:web:7f93c7ff3aeb76ff248965",
    measurementId: "G-N1SSGKLL35"
};
// TODO: Define the APP_ID to be used for Firestore collection paths.
const APP_ID = "ddugi"; // e.g., 'my-bugiroad-app'

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

app.use(cors({
    origin: 'http://127.0.0.1:5500' // Frontend website address (Live Server default)
}));
app.use(express.json());

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error('GEMINI_API_KEY environment variable is not set.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

// --- Tuggi Character Image URLs ---
const tugiImageMap = {
    'default': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(2)%20(1).png?alt=media&token=b3754220-4e08-4925-852b-1bb862b9fca5', // Default Tuggi
    'recommend': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(4).png?alt=media&token=b113ec37-7c12-4b93-96fd-1818ed093f97', // Tuggi when recommending a restaurant
    'thinking': 'https://firebasestorage.googleapis.com/v0/b/ddugidata.firebasestorage.app/o/Untitled%20(Copy).png?alt=media&token=8bef4637-6651-47c0-b5a6-177d810cf9bf',   // Tuggi when thinking/uncertain
    'greeting': 'https://placehold.co/100x100/B2F5EA/343A40?text=뚜기_인사',   // Tuggi when greeting
    'positive': 'https://placehold.co/100x100/C3F7D2/343A40?text=뚜기_긍정',   // Tuggi when positive/thankful
    'error': 'https://placehold.co/100x100/FF9999/343A40?text=뚜기_에러'    // Tuggi when an error occurs
};

// '뚜기' Character Persona and Knowledge Definition
const tugiPersona = `
    너는 이제부터 부산 사투리를 쓰는 부산 돼지 캐릭터 '뚜기'야.
    너의 목표는 부산을 방문하는 사람들에게 현지인 맛집과 숨겨진 명소를 추천해주고, 부산 문화에 대해 알려주는 거야.
    말 시작할때는 항상 마! 라고 말해, 약간 센척을 해 상남자처럼 얘기해, 하지만 욕이나 위협은 하지 않아, 대답은 길지않게.
    이전 대화를 기억하고 맥락에 맞춰 답변해줘.
`;

async function getRestaurantsFromFirestore(filters = {}) {
    try {
        let q = collection(db, 'artifacts', APP_ID, 'public', 'data', 'restaurants');

        if (filters.location) {
            q = query(q, where('location', '==', filters.location));
        }
        if (filters.type) {
            q = query(q, where('type', '==', filters.type));
        }

        const querySnapshot = await getDocs(q);
        const restaurants = [];
        querySnapshot.forEach((doc) => {
            restaurants.push({ id: doc.id, ...doc.data() });
        });
        return restaurants;
    } catch (error) {
        console.error('Error fetching restaurant data from Firestore:', error);
        return [];
    }
}

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    const chatHistory = req.body.history || []; // Previous conversation history from frontend

    if (!userMessage) {
        return res.status(400).json({ error: 'Please enter a message.' });
    }

    let recommendedRestaurant = null;
    let currentTugiImageKey = 'default'; // Default image key

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const lowerMessage = userMessage.toLowerCase();
        let queryFilters = {};
        if (lowerMessage.includes("해운대")) {
            queryFilters.location = "해운대";
        } else if (lowerMessage.includes("영도")) {
            queryFilters.location = "영도";
        } else if (lowerMessage.includes("서면")) {
            queryFilters.location = "서면";
        } else if (lowerMessage.includes("남포동")) {
            queryFilters.location = "남포동";
        }

        if (lowerMessage.includes("돼지국밥")) {
            queryFilters.type = "돼지국밥";
        } else if (lowerMessage.includes("카페")) {
            queryFilters.type = "카페";
        } else if (lowerMessage.includes("낙곱새")) {
            queryFilters.type = "낙곱새";
        } else if (lowerMessage.includes("밀면")) {
            queryFilters.type = "밀면";
        } else if (lowerMessage.includes("횟집")) {
            queryFilters.type = "횟집";
        }

        let restaurants = [];
        if (lowerMessage.includes("맛집") || lowerMessage.includes("추천") || Object.keys(queryFilters).length > 0) {
            restaurants = await getRestaurantsFromFirestore(queryFilters);
        }

        let contextInfo = "";
        if (restaurants.length > 0) {
            recommendedRestaurant = restaurants[Math.floor(Math.random() * restaurants.length)];
            contextInfo = `\n\n[참고할 맛집 정보]:\n- 이름: ${recommendedRestaurant.name}, 위치: ${recommendedRestaurant.location}, 종류: ${recommendedRestaurant.type}, 특징: ${recommendedRestaurant.desc}\n`;
            currentTugiImageKey = 'recommend'; // Image for restaurant recommendation
        } else if (lowerMessage.includes("맛집") || lowerMessage.includes("추천")) {
            const allRestaurants = await getRestaurantsFromFirestore({});
            if (allRestaurants.length > 0) {
                recommendedRestaurant = allRestaurants[Math.floor(Math.random() * allRestaurants.length)];
                contextInfo = `\n\n[참고할 맛집 정보]:\n- 이름: ${recommendedRestaurant.name}, 위치: ${recommendedRestaurant.location}, 종류: ${recommendedRestaurant.type}, 특징: ${recommendedRestaurant.desc}\n`;
                currentTugiImageKey = 'recommend';
            } else {
                contextInfo = "\n\n[참고: 현재 데이터베이스에 맛집 정보가 없거나, 요청하신 조건에 맞는 맛집이 없습니다.]\n";
                currentTugiImageKey = 'thinking'; // Image when no info
            }
        } else if (lowerMessage.includes("안녕") || lowerMessage.includes("반가워")) {
            currentTugiImageKey = 'greeting'; // Image for greeting
        } else if (lowerMessage.includes("고마워") || lowerMessage.includes("감사")) {
            currentTugiImageKey = 'positive'; // Image for thankfulness
        } else if (lowerMessage.includes("뭐해") || lowerMessage.includes("뭐라노")) {
            currentTugiImageKey = 'thinking'; // Image for ambiguous questions
        }

        // --- Core Change: Constructing `contents` for context ---
        const contents = [
            // Spread the existing chat history
            ...chatHistory,
            // Add the current user message along with context info as the latest user turn
            { role: "user", parts: [{ text: userMessage + contextInfo }] }
        ];

        const result = await model.generateContent({
            system_instruction: { parts: [{ text: tugiPersona }] }, // Pass persona as system instruction
            contents: contents // Pass the full conversation history
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
            tugi_image_url: tugiImageMap[currentTugiImageKey] // Send image URL
        });

    } catch (error) {
        console.error('Error during Gemini API or Firestore call:', error);
        res.status(500).json({
            error: '뚜기가 잠시 멍 때리고 있심더... 다시 말 걸어주이소.',
            tugi_image_url: tugiImageMap['error'] // Image for error
        });
    }
});

app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
});
