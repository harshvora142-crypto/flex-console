import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const PORT = 3000;

// Supabase Setup
const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function saveHighScores(players: Player[], game: string) {
  if (!supabaseUrl || !supabaseAnonKey) return;
  
  // Filter out players with no score to save data space
  const activePlayers = players.filter(p => p.score > 0);
  if (activePlayers.length === 0) return;

  try {
    // Strategy: We keep only the best score for each player per game.
    // This turns a potential 1,000,000 row table into a much smaller player-base table.
    for (const player of activePlayers) {
      const { data: existing } = await supabase
        .from('high_scores')
        .select('score')
        .eq('player_name', player.name)
        .eq('game_id', game)
        .single();

      if (!existing || player.score > existing.score) {
        await supabase.from('high_scores').upsert({
          player_name: player.name,
          score: player.score,
          game_id: game,
          created_at: new Date().toISOString()
        }, { onConflict: 'player_name,game_id' });
      }
    }

    // Secondary Strategy: Periodically trim the table to Top 1000 globally 
    // (This is usually done via a DB edge function, but we can nudge it here)
  } catch (err) {
    console.error('Supabase sync error:', err);
  }
}

interface Player {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  color: string;
}

interface Room {
  id: string;
  players: Player[];
  hostId: string;
  state: 'LOBBY' | 'GAME_SELECT' | 'PLAYING' | 'RESULTS';
  game: string | null;
  gameState: any;
  tvId?: string;
}

const rooms = new Map<string, Room>();
const gameIntervals = new Map<string, NodeJS.Timeout>();
const roomActivity = new Map<string, number>();

// Cleanup stale rooms (e.g. if everything disconnects unexpectedly)
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    const lastActive = roomActivity.get(roomId) || now;
    // If room is older than 2 hours and has no players, or just 4 hours old anyway
    if (now - lastActive > 1000 * 60 * 60 * 4 || (room.players.length === 0 && now - lastActive > 1000 * 60 * 30)) {
      console.log(`Cleaning up stale room ${roomId}`);
      rooms.delete(roomId);
      roomActivity.delete(roomId);
      const interval = gameIntervals.get(roomId);
      if (interval) clearInterval(interval);
    }
  });
}, 1000 * 60 * 15); // Check every 15 mins

const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

const QUIZ_QUESTIONS = [
  { text: "What is 7 x 8?", options: ["54", "56", "64", "48"], correct: 1 },
  { text: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Saturn"], correct: 1 },
  { text: "What is the capital of Japan?", options: ["Seoul", "Beijing", "Tokyo", "Bangkok"], correct: 2 },
  { text: "How many legs does a spider have?", options: ["6", "8", "10", "12"], correct: 1 },
];

const DRAWING_WORDS = [
  "Elephant", "Pizza", "Skyscraper", "Bicycle", "Sunflower", 
  "Cat", "Mountain", "Computer", "Guitar", "Rocket",
  "Butterfly", "Donut", "Volcano", "Robot", "Tornado"
];

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const server = createServer(app);
  const io = new Server(server, {
    cors: { 
      origin: true,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 New connection: \x1b[32m${socket.id}\x1b[0m`);

    socket.on('create_room', (callback) => {
      let roomId = generateRoomCode();
      while (rooms.has(roomId)) roomId = generateRoomCode();

      const newRoom: Room = {
        id: roomId,
        players: [],
        hostId: '',
        state: 'LOBBY',
        game: null,
        gameState: {}
      };
      
      rooms.set(roomId, newRoom);
      roomActivity.set(roomId, Date.now());
      callback({ roomId });
    });

    socket.on('join_tv', ({ roomId }, callback) => {
      const room = rooms.get(roomId);
      if (!room) return callback({ error: 'Room not found' });
      room.tvId = socket.id;
      socket.join(roomId);
      callback({ success: true, room });
    });

    socket.on('join_room', ({ roomId, playerName }, callback) => {
      const room = rooms.get(roomId?.toUpperCase());
      if (!room) return callback({ error: 'Room not found' });
      if (room.players.length >= 8) return callback({ error: 'Room is full' });
      if (room.state !== 'LOBBY') return callback({ error: 'Game already in progress' });

      const isHost = room.players.length === 0;
      const player: Player = {
        id: socket.id,
        name: playerName,
        isHost,
        score: 0,
        color: COLORS[room.players.length % COLORS.length]
      };

      if (isHost) room.hostId = socket.id;
      room.players.push(player);
      socket.join(roomId);
      
      io.to(roomId).emit('room_state_update', room);
      callback({ success: true, player, room });
    });

    socket.on('host_action', ({ roomId, action, payload }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id) return;

      switch (action) {
        case 'start_game_select':
          room.state = 'GAME_SELECT';
          room.game = null;
          room.gameState = {};
          break;
        case 'select_game':
          room.game = payload.gameId;
          break;
        case 'start_game':
          startGame(room, io);
          break;
        case 'restart_match':
          room.state = 'LOBBY';
          room.game = null;
          room.gameState = {};
          break;
        case 'kick_player':
          room.players = room.players.filter(p => p.id !== payload.playerId);
          io.to(payload.playerId).emit('kicked');
          break;
        case 'end_racing_game':
          room.gameState.status = 'finished';
          if (payload && payload.scores) {
            for (const p of room.players) {
              if (payload.scores[p.id]) {
                p.score += payload.scores[p.id];
              }
            }
          }
          saveHighScores(room.players, room.game || 'unknown');
          room.state = 'RESULTS';
          break;
      }
      roomActivity.set(roomId, Date.now());
      io.to(roomId).emit('room_state_update', room);
    });

    socket.on('game_input', ({ roomId, action, payload }) => {
      const room = rooms.get(roomId);
      if (!room || room.state !== 'PLAYING') return;
      
      if (room.game === 'racing') {
        io.to(roomId).emit('racing_input', { playerId: socket.id, action, payload });
        return;
      }
      
      handleGameInput(room, socket.id, action, payload, io);
      roomActivity.set(roomId, Date.now());
    });

    socket.on('disconnect', () => {
      rooms.forEach((room, roomId) => {
        // Handle TV Disconnect
        if (room.tvId === socket.id) {
          console.log(`TV disconnected, deleting room ${roomId}`);
          const interval = gameIntervals.get(roomId);
          if (interval) {
            clearInterval(interval);
            gameIntervals.delete(roomId);
          }
          io.to(roomId).emit('room_terminated', { reason: 'TV disconnected' });
          rooms.delete(roomId);
          return;
        }

        // Handle Player Disconnect
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          room.players.splice(playerIndex, 1);
          if (room.players.length === 0) {
            const interval = gameIntervals.get(roomId);
            if (interval) {
              clearInterval(interval);
              gameIntervals.delete(roomId);
            }
            rooms.delete(roomId);
          } else if (room.hostId === socket.id) {
            // Host left
            room.hostId = room.players[0].id;
            room.players[0].isHost = true;
            
            if (room.state === 'PLAYING' || room.state === 'GAME_SELECT' || room.state === 'RESULTS') {
              room.state = 'LOBBY';
              room.game = null;
              room.gameState = {};
              io.to(roomId).emit('host_left');
            }
            io.to(roomId).emit('room_state_update', room);
          } else {
            io.to(roomId).emit('room_state_update', room);
          }
        }
      });
    });
  });

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  
  app.get('/api/config', (req, res) => {
    const networkInterfaces = os.networkInterfaces();
    let ip = 'localhost';
    for (const name of Object.keys(networkInterfaces)) {
      for (const net of networkInterfaces[name]!) {
        if (net.family === 'IPv4' && !net.internal) {
          ip = net.address;
          break;
        }
      }
    }
    res.json({ ip });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, '0.0.0.0', () => {
    const networkInterfaces = os.networkInterfaces();
    console.log(`\x1b[36m%s\x1b[0m`, `\n  VITE v5.1.4  ready in 124 ms\n`);
    console.log(`  \x1b[1m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:${PORT}/\x1b[0m`);
    
    let found = false;
    for (const name of Object.keys(networkInterfaces)) {
      for (const net of networkInterfaces[name]!) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  \x1b[1m➜\x1b[0m  \x1b[1mNetwork\x1b[0m: \x1b[36mhttp://${net.address}:${PORT}/\x1b[0m`);
          found = true;
        }
      }
    }
    console.log(`\n  \x1b[2mpress h + enter to show help\x1b[0m\n`);
    if (!found) console.log(`  \x1b[33m⚠️  No WiFi detected. Use cloud tunnel.\x1b[0m\n`);
  });
}

function startGame(room: Room, io: Server) {
  room.state = 'PLAYING';
  const existingInterval = gameIntervals.get(room.id);
  if (existingInterval) {
    clearInterval(existingInterval);
    gameIntervals.delete(room.id);
  }

  if (room.game === 'reaction') {
    room.gameState = { status: 'waiting', winner: null };
    const delay = Math.floor(Math.random() * 3000) + 2000; // 2-5 seconds
    const interval = setTimeout(() => {
      if (room.state === 'PLAYING' && room.gameState.status === 'waiting') {
        room.gameState.status = 'go';
        io.to(room.id).emit('room_state_update', room);
      }
    }, delay);
    gameIntervals.set(room.id, interval);
  } else if (room.game === 'quiz') {
    room.gameState = { 
      questionIndex: 0, 
      answers: {}, 
      status: 'question',
      currentQuestion: QUIZ_QUESTIONS[0]
    };
  } else if (room.game === 'racing') {
    room.gameState = { status: 'playing', winner: null };
  } else if (room.game === 'drawing') {
    const drawerId = room.players[0].id;
    const words = [...DRAWING_WORDS].sort(() => 0.5 - Math.random()).slice(0, 3);
    room.gameState = {
      status: 'word_selection',
      drawerId,
      wordOptions: words,
      word: '',
      timeLeft: 60,
      currentStrokes: [],
      guesses: {}
    };
  }
}

function handleGameInput(room: Room, playerId: string, action: string, payload: any, io: Server) {
  if (!room.gameState) return;

  if (room.game === 'reaction') {
    if (action === 'press') {
      if (room.gameState.status === 'go' && !room.gameState.winner) {
        room.gameState.winner = playerId;
        room.gameState.status = 'finished';
        const player = room.players.find(p => p.id === playerId);
        if (player) player.score += 100;
        
        setTimeout(() => {
          saveHighScores(room.players, room.game || 'reaction');
          room.state = 'RESULTS';
          io.to(room.id).emit('room_state_update', room);
        }, 3000);
      } else if (room.gameState.status === 'waiting') {
        const player = room.players.find(p => p.id === playerId);
        if (player) player.score = Math.max(0, player.score - 50);
      }
    }
  } else if (room.game === 'quiz') {
    if (action === 'answer' && room.gameState.status === 'question') {
      if (room.gameState.answers[playerId] === undefined) {
        room.gameState.answers[playerId] = payload.answer;
        
        // Check if everyone answered
        if (Object.keys(room.gameState.answers).length === room.players.length) {
          room.gameState.status = 'reveal';
          const correct = room.gameState.currentQuestion.correct;
          
          room.players.forEach(p => {
            if (room.gameState.answers[p.id] === correct) {
              p.score += 100;
            }
          });
          
          io.to(room.id).emit('room_state_update', room);
          
          setTimeout(() => {
            room.gameState.questionIndex++;
            if (room.gameState.questionIndex >= QUIZ_QUESTIONS.length) {
              saveHighScores(room.players, room.game || 'quiz');
              room.state = 'RESULTS';
            } else {
              room.gameState.status = 'question';
              room.gameState.answers = {};
              room.gameState.currentQuestion = QUIZ_QUESTIONS[room.gameState.questionIndex];
            }
            io.to(room.id).emit('room_state_update', room);
          }, 4000);
        }
      }
    }
  } else if (room.game === 'drawing') {
    if (action === 'select_word' && playerId === room.gameState.drawerId && room.gameState.status === 'word_selection') {
      room.gameState.word = payload.word;
      room.gameState.status = 'drawing';
      
      const interval = setInterval(() => {
        if (room.state !== 'PLAYING' || room.game !== 'drawing') {
          clearInterval(interval);
          return;
        }
        
        room.gameState.timeLeft--;
        if (room.gameState.timeLeft <= 0) {
          clearInterval(interval);
          room.gameState.status = 'reveal';
          io.to(room.id).emit('room_state_update', room);
          
          setTimeout(() => {
            saveHighScores(room.players, 'drawing');
            room.state = 'RESULTS';
            io.to(room.id).emit('room_state_update', room);
          }, 5000);
        } else {
          io.to(room.id).emit('room_state_update', room);
        }
      }, 1000);
      gameIntervals.set(room.id, interval);
    } else if (action === 'draw_stroke' && playerId === room.gameState.drawerId && room.gameState.status === 'drawing') {
      room.gameState.currentStrokes.push(payload.stroke);
    } else if (action === 'guess' && playerId !== room.gameState.drawerId && room.gameState.status === 'drawing') {
      if (payload.guess.toLowerCase() === room.gameState.word.toLowerCase() && !room.gameState.guesses[playerId]) {
        room.gameState.guesses[playerId] = true;
        const player = room.players.find(p => p.id === playerId);
        if (player) player.score += 100;
        
        // Bonus for drawer if someone guesses
        const drawer = room.players.find(p => p.id === room.gameState.drawerId);
        if (drawer) drawer.score += 50;

        // If everyone guessed
        const guessersCount = Object.keys(room.gameState.guesses).length;
        if (guessersCount === room.players.length - 1) {
          room.gameState.timeLeft = 0; // Trigger reveal in next interval tick
        }
      }
    }
  }
  io.to(room.id).emit('room_state_update', room);
}

startServer();
