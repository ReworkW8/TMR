
CREATE TABLE players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    login VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100) NOT NULL,
    coppers INT DEFAULT 0,
    ladder_points INT DEFAULT 0,
    zone VARCHAR(100) DEFAULT 'World'
);

CREATE TABLE servers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    login VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    port INT NOT NULL,
    player_count INT DEFAULT 0,
    max_players INT DEFAULT 32
);

CREATE TABLE copper_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sender_login VARCHAR(50),
    receiver_login VARCHAR(50),
    amount INT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
