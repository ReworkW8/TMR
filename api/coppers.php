<?php

$db = new PDO('mysql:host=https://reworkw8.github.io/TMR/;dbname=tmr_master', 'root', '');

$sender = $_POST['sender'] ?? '';
$receiver = $_POST['receiver'] ?? '';
$amount = (int)($_POST['amount'] ?? 0);

if ($amount > 0) {
    $db->beginTransaction();
    try {

        $stmt = $db->prepare("UPDATE players SET coppers = coppers - :amount WHERE login = :sender AND coppers >= :amount");
        $stmt->execute(['amount' => $amount, 'sender' => $sender]);
        
        if ($stmt->rowCount() > 0) {

            $stmt = $db->prepare("UPDATE players SET coppers = coppers + :amount WHERE login = :receiver");
            $stmt->execute(['amount' => $amount, 'receiver' => $receiver]);
            

            $stmt = $db->prepare("INSERT INTO copper_transactions (sender_login, receiver_login, amount) VALUES (?, ?, ?)");
            $stmt->execute([$sender, $receiver, $amount]);
            
            $db->commit();
            echo json_encode(['status' => 'success', 'message' => 'Coppers transferred.']);
        } else {
            $db->rollBack();
            echo json_encode(['status' => 'error', 'message' => 'Not enough coppers.']);
        }
    } catch (Exception $e) {
        $db->rollBack();
        echo json_encode(['status' => 'error', 'message' => 'Database error.']);
    }
}
?>