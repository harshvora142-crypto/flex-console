import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

socket.on('connect', () => {
    console.log('Connected to server');
    
    // Create a room (Server has socket.on('create_room'))
    socket.emit('create_room', (response: any) => {
        console.log('Room created:', response);
        const roomId = response.roomId;

        // Join as a player from another socket
        const playerSocket = io('http://localhost:3000');
        playerSocket.on('connect', () => {
            console.log('Player connected');
            // Server expects { roomId, playerName }
            playerSocket.emit('join_room', { roomId, playerName: 'TestPlayer' }, (joinResponse: any) => {
                console.log('Player joined:', joinResponse);
                
                if (joinResponse.success) {
                    console.log('Multiplayer Join SUCCESS');
                    
                    // Simulate input
                    playerSocket.emit('racing_input', { roomId, action: 'LEFT_PRESS' });
                    console.log('Input sent');
                    
                    setTimeout(() => {
                        console.log('Verification Complete');
                        process.exit(0);
                    }, 1000);
                } else {
                    console.log('Multiplayer Join FAILED');
                    process.exit(1);
                }
            });
        });
    });
});

setTimeout(() => {
    console.log('Timeout');
    process.exit(1);
}, 5000);
