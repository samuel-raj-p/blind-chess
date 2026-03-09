const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GAME STATE ---
let game = new Chess();
let players = { white: null, black: null };
let revealedSquares = new Set(); // Tracks squares of pieces that gave check

// --- FEN FILTERING LOGIC ---
function filterFen(fen, viewerColor) {
    const parts = fen.split(' ');
    const board = parts[0];
    const ranks = board.split('/');
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rankNames = ['8', '7', '6', '5', '4', '3', '2', '1'];

    let newRanks = [];
    for (let r = 0; r < 8; r++) {
        let row = ranks[r];
        let newRow = '';
        let fileIdx = 0;
        for (let i = 0; i < row.length; i++) {
            let char = row[i];
            if (isNaN(char)) {
                let sq = files[fileIdx] + rankNames[r];
                let isWhite = char === char.toUpperCase();
                let pieceColor = isWhite ? 'white' : 'black';
                let isKing = char.toLowerCase() === 'k';

                // REVEAL LOGIC: Keep if it's my piece, any King, or a revealed piece
                let keep = false;
                if (isKing) keep = true;
                if (pieceColor === viewerColor) keep = true;
                if (revealedSquares.has(sq)) keep = true;

                if (keep) {
                    newRow += char;
                } else {
                    newRow += '1'; // Replace with 1 empty space (invisible)
                }
                fileIdx++;
            } else {
                newRow += char;
                fileIdx += parseInt(char);
            }
        }
        
        // Compress consecutive empty spaces (1s) back into standard FEN format
        let compressedRow = '';
        let emptyCount = 0;
        for (let c of newRow) {
            if (c === '1') {
                emptyCount++;
            } else {
                if (emptyCount > 0) { compressedRow += emptyCount; emptyCount = 0; }
                compressedRow += c;
            }
        }
        if (emptyCount > 0) compressedRow += emptyCount;
        newRanks.push(compressedRow);
    }
    parts[0] = newRanks.join('/');
    return parts.join(' ');
}

function broadcastState() {
    if (game.isGameOver()) {
        // Game over! Reveal the true board to everyone.
        let result = "Draw/Stalemate";
        if (game.isCheckmate()) result = "Checkmate!";
        io.emit('game_over', { fen: game.fen(), result: result });
        return;
    }

    const turn = game.turn() === 'w' ? 'white' : 'black';

    if (players.white) {
        io.to(players.white).emit('update', {
            fen: filterFen(game.fen(), 'white'),
            turn: turn,
            color: 'white'
        });
    }
    if (players.black) {
        io.to(players.black).emit('update', {
            fen: filterFen(game.fen(), 'black'),
            turn: turn,
            color: 'black'
        });
    }
}

// --- WEBSOCKET HANDLERS ---
io.on('connection', (socket) => {
    socket.on('join', (color) => {
        if (color === 'white' && !players.white) {
            players.white = socket.id;
        } else if (color === 'black' && !players.black) {
            players.black = socket.id;
        } else {
            return socket.emit('error', 'That color is taken or game is full! Max 2 players.');
        }
        broadcastState();
    });

    socket.on('move', (data) => {
        const playerColor = socket.id === players.white ? 'white' : 'black';
        const currentTurn = game.turn() === 'w' ? 'white' : 'black';

        if (playerColor !== currentTurn) {
            return socket.emit('invalid_move');
        }

        try {
            // Attempt the move
            const move = game.move({
                from: data.source,
                to: data.target,
                promotion: 'q' // Auto-promote to queen for simplicity
            });

            if (move) {
                // Update tracker: If a revealed piece moved, track its new square
                if (revealedSquares.has(data.source)) {
                    revealedSquares.delete(data.source);
                    revealedSquares.add(data.target);
                }
                
                // If this move causes a check, permanently reveal the piece that just moved
                if (game.isCheck()) {
                    revealedSquares.add(data.target);
                }

                broadcastState();
            } else {
                socket.emit('invalid_move');
            }
        } catch (e) {
            socket.emit('invalid_move');
        }
    });

    socket.on('rematch', () => {
        game.reset();
        revealedSquares.clear();
        broadcastState();
    });

    socket.on('disconnect', () => {
        if (socket.id === players.white) players.white = null;
        if (socket.id === players.black) players.black = null;
    });
});

// --- FRONTEND INJECTION (HTML/CSS/JS) ---
const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
    <title>Blind Chess</title>
    <link rel="stylesheet" href="https://unpkg.com/@chrisoakman/chessboardjs@1.0.0/dist/chessboard-1.0.0.min.css">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; flex-direction: column; align-items: center; background: #1a1a1a; color: #fff; margin-top: 50px; }
        #board { width: 500px; margin: 20px 0; border: 4px solid #333; border-radius: 4px; box-shadow: 0 10px 20px rgba(0,0,0,0.5); }
        .btn { padding: 12px 24px; font-size: 16px; margin: 5px; cursor: pointer; border: none; border-radius: 5px; font-weight: bold; transition: 0.2s; }
        .btn-white { background: #f1c40f; color: #000; }
        .btn-white:hover { background: #f39c12; }
        .btn-black { background: #34495e; color: #fff; }
        .btn-black:hover { background: #2c3e50; }
        .btn-rematch { background: #e74c3c; color: white; display: none; margin-top: 15px;}
        .btn-rematch:hover { background: #c0392b; }
        #status { font-size: 24px; font-weight: bold; color: #2ecc71; margin-bottom: 10px; }
        #setup { text-align: center; }
    </style>
</head>
<body>

    <div id="setup">
        <h1 style="color: #e74c3c;">BLIND CHESS</h1>
        <p>Opponent pieces are invisible! Checks reveal the attacker.</p>
        <button class="btn btn-white" onclick="join('white')">Play White</button>
        <button class="btn btn-black" onclick="join('black')">Play Black</button>
    </div>

    <div id="game-area" style="display:none; text-align: center;">
        <div id="status">Waiting for opponent...</div>
        <div id="board"></div>
        <button class="btn btn-rematch" id="rematchBtn" onclick="rematch()">Request Rematch</button>
    </div>

    <script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
    <script src="https://unpkg.com/@chrisoakman/chessboardjs@1.0.0/dist/chessboard-1.0.0.min.js"></script>
    <script src="/socket.io/socket.io.js"></script>

    <script>
        const socket = io();
        let board = null;
        let myColor = null;
        let currentFen = 'start';

        function join(color) {
            myColor = color;
            socket.emit('join', color);
            $('#setup').hide();
            $('#game-area').show();
            
            board = Chessboard('board', {
                draggable: true,
                position: 'start',
                orientation: color,
                onDrop: onDrop
            });
        }

        function onDrop(source, target) {
            // Send the move. If it's illegal or moving into an invisible piece, 
            // the server will reject it and snap the board back.
            socket.emit('move', { source: source, target: target });
        }

        socket.on('update', function(data) {
            currentFen = data.fen;
            board.position(data.fen, false); // false prevents animation glitching with invisible pieces
            $('#status').text(data.turn === myColor ? "Your Turn" : "Opponent's Turn");
            $('#status').css('color', data.turn === myColor ? '#2ecc71' : '#e74c3c');
            $('#rematchBtn').hide();
        });

        socket.on('invalid_move', function() {
            board.position(currentFen, false);
        });

        socket.on('game_over', function(data) {
            board.position(data.fen, false); // Reveals everything!
            $('#status').text("Game Over! " + data.result);
            $('#status').css('color', '#f1c40f');
            $('#rematchBtn').show();
        });

        socket.on('error', function(msg) {
            alert(msg);
            location.reload();
        });

        function rematch() {
            socket.emit('rematch');
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HTML_CONTENT));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(\`🚀 Blind Chess Server running! Open http://localhost:\${PORT} in your browser.\`);
});
