/**
 * MQTT sequence ids for the commands this server sends. Bambu Studio numbers its own from 20000 to 30000 and
 * uses "0" for cloud-originated commands (DevUtil.h STUDIO_START_SEQ_ID, CLOUD_SEQ_ID); printers echo the id in
 * their reply. A counter in a range of its own (40000-49999) keeps this server's replies apart from Studio's and
 * the cloud's, and fits Studio's stoi parsing.
 */
const FIRST = 40000;
const LAST = 49999;
let next = FIRST + Math.floor(Math.random() * (LAST - FIRST + 1));
export function nextSequenceId() {
    const id = next;
    next = next >= LAST ? FIRST : next + 1;
    return String(id);
}
