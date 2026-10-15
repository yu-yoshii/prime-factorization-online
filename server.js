const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const VERSION = "v2.0.4";
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://e221239_db_user:Y0u667841you@cluster0.yxjjzel.mongodb.net/strawberry_kingdom?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'prime_factorization_online';

let db, usersCollection;
let rooms = {};

async function startServer() {
    try {
        const client = await MongoClient.connect(MONGO_URL);
        console.log('MongoDB接続完了:', MONGO_URL);
        db = client.db(DB_NAME);
        usersCollection = db.collection('users');
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`サーバー起動 (${VERSION}): ポート ${PORT}`);
        });
    } catch (err) {
        console.error('MongoDB接続エラー:', err);
    }
}

startServer();

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '入力してください。' });
    
    try {
        if (!usersCollection) return res.json({ success: false, message: 'データベースが未接続です。' });
        const existing = await usersCollection.findOne({ username });
        if (existing) return res.json({ success: false, message: 'そのユーザー名は既に使われています。' });

        const result = await usersCollection.insertOne({ username, password, rating: 1000 });
        res.json({ success: true, user: { id: result.insertedId.toString(), username, rating: 1000 } });
    } catch (err) {
        res.json({ success: false, message: '登録エラーが発生しました。' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!usersCollection) return res.json({ success: false, message: 'データベースが未接続です。' });
        const user = await usersCollection.findOne({ username, password });
        if (!user) return res.json({ success: false, message: 'ユーザー名またはパスワードが違います。' });
        res.json({ success: true, user: { id: user._id.toString(), username: user.username, rating: user.rating } });
    } catch (err) {
        res.json({ success: false, message: 'ログインエラーが発生しました。' });
    }
});

function isPrime(n) {
    if (n < 2) return false;
    for (let i = 2; i <= Math.sqrt(n); i++) {
        if (n % i === 0) return false;
    }
    return true;
}

function evaluateMultiplication(expr) {
    let pos = 0;
    function parseNumber() {
        let start = pos;
        while (pos < expr.length && expr[pos] >= '0' && expr[pos] <= '9') {
            pos++;
        }
        if (start === pos) throw new Error('数値を期待しています');
        return parseInt(expr.substring(start, pos), 10);
    }

    function parseTerm() {
        let val = parseNumber();
        while (true) {
            while (pos < expr.length && expr[pos] === ' ') pos++;
            if (pos < expr.length && expr[pos] === '*') {
                pos++;
                while (pos < expr.length && expr[pos] === ' ') pos++;
                val *= parseNumber();
            } else {
                break;
            }
        }
        return val;
    }

    let val = parseTerm();
    while (pos < expr.length && expr[pos] === ' ') pos++;
    if (pos < expr.length) throw new Error('無効な式です');
    return val;
}

async function getLobbyInfo() {
    try {
        const ranking = await usersCollection.find({}, { projection: { username: 1, rating: 1 } })
            .sort({ rating: -1 })
            .limit(10)
            .toArray();
            
        const formattedRanking = ranking.map(u => ({ username: u.username, rating: u.rating }));
        const roomList = Object.keys(rooms).map(roomId => ({
            roomId,
            host: rooms[roomId].hostName,
            difficulty: rooms[roomId].difficulty,
            difficultyLabel: rooms[roomId].difficultyLabel,
            playerCount: rooms[roomId].players.length,
            status: rooms[roomId].isGameStarted ? '対戦中' : '募集中'
        }));
        return { ranking: formattedRanking, roomList };
    } catch (err) {
        return { ranking: [], roomList: [] };
    }
}

async function broadcastLobbyData() {
    const data = await getLobbyInfo();
    io.emit('lobbyData', data);
}

function getBaseRatingChange(rankIndex, totalPlayers) {
    if (totalPlayers === 2) return rankIndex === 0 ? 24 : -12;
    if (rankIndex === 0) return 24;
    if (rankIndex === 1) return 4;
    if (rankIndex === 2) return -8;
    return -16;
}

io.on('connection', (socket) => {
    socket.on('restoreSession', async (userId, callback) => {
        try {
            if (!ObjectId.isValid(userId)) return callback({ success: false });
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) {
                callback({ success: false });
            } else {
                const userData = { id: user._id.toString(), username: user.username, rating: user.rating };
                socket.user = userData;
                callback({ success: true, user: userData });
            }
        } catch (err) {
            callback({ success: false });
        }
    });

    socket.on('requestLobbyData', async () => {
        const data = await getLobbyInfo();
        socket.emit('lobbyData', data);
    });

    socket.on('createRoom', async ({ userId, difficulty }) => {
        try {
            if (!ObjectId.isValid(userId)) return;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) return;

            const diffLabels = { easy: '初級 (2桁)', medium: '中級 (3桁)', hard: '上級 (4桁)' };
            const diffLabel = diffLabels[difficulty] || '初級 (2桁)';

            const roomId = 'room_' + Date.now();
            rooms[roomId] = {
                roomId,
                version: VERSION,
                hostId: socket.id,
                hostName: user.username,
                difficulty: difficulty || 'easy',
                difficultyLabel: diffLabel,
                isGameStarted: false,
                players: [{
                    id: socket.id,
                    dbId: user._id.toString(),
                    username: user.username,
                    rating: user.rating,
                    score: 0,
                    ratingChange: 0
                }],
                targetNumber: 0,
                currentRound: 1,
                isReviewing: false,
                isGameOver: false,
                message: `${user.username} が部屋を作成しました。メンバーを待っています...`
            };

            socket.join(roomId);
            socket.emit('joinedRoom', rooms[roomId]);
            broadcastLobbyData();
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('joinRoom', async ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room || room.isGameStarted || room.players.length >= 4) {
            socket.emit('notify', 'この部屋には参加できません。');
            return;
        }

        try {
            if (!ObjectId.isValid(userId)) return;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) return;

            if (room.players.some(p => p.dbId === user._id.toString())) {
                socket.emit('joinedRoom', room);
                return;
            }

            room.players.push({
                id: socket.id,
                dbId: user._id.toString(),
                username: user.username,
                rating: user.rating,
                score: 0,
                ratingChange: 0
            });

            socket.join(roomId);
            io.to(roomId).emit('updateState', room);
            broadcastLobbyData();
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id || room.isGameStarted) return;
        room.isGameStarted = true;
        room.message = `【${room.difficultyLabel}】対戦開始！ 与えられた数を素因数分解せよ！（3本先取）`;
        initGame(room);
        io.to(roomId).emit('updateState', room);
        broadcastLobbyData();
    });

    // 解答送信処理（すべての参加者から受け付けられるよう修正）
    socket.on('tryCalc', ({ roomId, expression }) => {
        const room = rooms[roomId];
        if (!room || !room.isGameStarted || room.isReviewing || room.isGameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        try {
            const sanitized = expression.replace(/\s+/g, '');
            if (!/^[0-9\*]+$/.test(sanitized)) {
                throw new Error('数字と「*」以外の文字が含まれています');
            }

            const numbers = sanitized.split('*').map(n => parseInt(n, 10));
            for (let num of numbers) {
                if (!isPrime(num)) {
                    socket.emit('notify', `「${num}」は素数ではありません。すべての因数が素数である必要があります。`);
                    return;
                }
            }

            const result = evaluateMultiplication(sanitized);

            if (result === room.targetNumber) {
                player.score++;
                room.isReviewing = true;
                room.message = `🎉 ${player.username} が正解！ 「${expression} = ${room.targetNumber}」`;
                io.to(roomId).emit('updateState', room);

                setTimeout(async () => {
                    if (!rooms[roomId]) return;

                    if (player.score >= 3) {
                        room.isGameOver = true;
                        const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
                        const totalPlayers = sortedPlayers.length;

                        let rankGroups = [];
                        let i = 0;
                        while (i < totalPlayers) {
                            let group = [sortedPlayers[i]];
                            let j = i + 1;
                            while (j < totalPlayers && sortedPlayers[j].score === sortedPlayers[i].score) {
                                group.push(sortedPlayers[j]);
                                j++;
                            }
                            rankGroups.push(group);
                            i = j;
                        }

                        let calculatedChanges = new Map();
                        let currentRankIndex = 0;

                        rankGroups.forEach(group => {
                            let groupSize = group.length;
                            let sumChanges = 0;
                            for (let k = 0; k < groupSize; k++) {
                                sumChanges += getBaseRatingChange(currentRankIndex + k, totalPlayers);
                            }
                            let avgChange = Math.round(sumChanges / groupSize);
                            group.forEach(p => calculatedChanges.set(p.dbId, avgChange));
                            currentRankIndex += groupSize;
                        });

                        for (let p of sortedPlayers) {
                            let change = totalPlayers === 1 ? 0 : (calculatedChanges.get(p.dbId) || 0);
                            p.ratingChange = change;
                            try {
                                const userDoc = await usersCollection.findOne({ _id: new ObjectId(p.dbId) });
                                if (userDoc) {
                                    let newRating = Math.max(100, userDoc.rating + change);
                                    await usersCollection.updateOne({ _id: new ObjectId(p.dbId) }, { $set: { rating: newRating } });
                                    p.rating = newRating;
                                }
                            } catch (err) {}
                        }

                        room.message = `🏆 試合終了！ 勝者: ${sortedPlayers[0].username} 🎉`;
                        io.to(roomId).emit('updateState', room);
                        broadcastLobbyData();
                        return;
                    } else {
                        room.currentRound++;
                        room.message = `ラウンド勝利: ${player.username}！次の問題へ...`;
                    }

                    room.isReviewing = false;
                    initGame(room);
                    io.to(roomId).emit('updateState', room);
                }, 5000);

            } else {
                socket.emit('notify', `計算結果が ${result} です（お題の数 ${room.targetNumber} と一致しません）。`);
            }
        } catch (e) {
            socket.emit('notify', '式が無効です。「2*3*5」のように数字と*で入力してください。');
        }
    });

    socket.on('leaveGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                if (room.hostId === socket.id) {
                    room.hostId = room.players[0].id;
                    room.hostName = room.players[0].username;
                }
                io.to(roomId).emit('updateState', room);
            }
        }
        broadcastLobbyData();
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                        room.hostName = room.players[0].username;
                    }
                    io.to(roomId).emit('updateState', room);
                }
            }
        }
        broadcastLobbyData();
    });
});

function initGame(room) {
    let min = 10, max = 99;
    if (room.difficulty === 'medium') {
        min = 100; max = 999;
    } else if (room.difficulty === 'hard') {
        min = 1000; max = 9999;
    }
    let num;
    do {
        num = Math.floor(Math.random() * (max - min + 1)) + min;
    } while (isPrime(num));
    room.targetNumber = num;
}