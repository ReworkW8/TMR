<?php

$db = new PDO('mysql:host=https://reworkw8.github.io/TMR/;dbname=tmr_master', 'root', '');

$login = $_POST['login'] ?? '';
$password = $_POST['password'] ?? '';

$stmt = $db->prepare("SELECT * FROM players WHERE login = :login");
$stmt->execute(['login' => $login]);
$player = $stmt->fetch();

if ($player && password_verify($password, $player['password_hash'])) {
    echo json_encode(['status' => 'success', 'message' => 'Login OK', 'coppers' => $player['coppers']]);
} else {
    echo json_encode(['status' => 'error', 'message' => 'Invalid login']);
}
?>