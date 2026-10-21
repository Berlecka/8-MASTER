/* ============================================================================
 *  engine-8master.js  —  Moteur de règles pur du jeu 8-Master V2
 * ----------------------------------------------------------------------------
 *  Version       : 1.0.1
 *  Auteur        : Projet 8-Master V2
 *  Statut        : PRD figé à 100 % — conforme aux 8 points + 6 re-pass
 * ----------------------------------------------------------------------------
 *  CARACTÉRISTIQUES
 *  - Aucune dépendance DOM / audio / timer / réseau
 *  - Réutilisable en Solo, Multijoueur et Tournois (côté serveur autoritaire)
 *  - State 100 % sérialisable JSON (sauvegarde Supabase / snapshot Replay)
 *  - Chaque action retourne { valid, state, events }
 *
 *  CHANGELOG 1.0.1
 *  - AI_DELAY_MS : latence fixe de 2000 ms pour toutes les vitesses (Solo)
 * ========================================================================== */

(function (global) {
    'use strict';

    /* ========================================================================
     *  1. CONFIGURATION
     * ===================================================================== */

    const CONFIG = Object.freeze({
        SUITS: ['♥️', '♦️', '♣️', '♠️'],
        VALUES: ['2','3','4','5','6','7','8','9','10','J','Q','K','A'],

        POINTS: Object.freeze({
            '2': 22, '8': 32, 'A': 11, '10': 10,
            'J': 1,  'Q': 1,  'K': 1,
        }),

        EIGHT_BONUS_ON_WIN: -32,

        MIN_CARDS_PER_DECK: 3,
        MAX_CARDS_PER_DECK: 8,

        // ✅ Latence fixe de 2 secondes pour tous les bots (toutes vitesses)
        AI_DELAY_MS: Object.freeze({ slow: 2000, normal: 2000, fast: 2000, turbo: 2000 }),

        THRESHOLD: Object.freeze({
            ELIMINATION:       101,
            GRACE_TRIGGER:     100,
            GRACE_AMOUNT:       10,
            STREAK_WIN_COUNT:    3,
            STREAK_WIN_REWARD: -10
        }),

        PLAYER_RANGE: Object.freeze({ MIN: 2, MAX: 15 }),

        DECK_AUTO_TIERS: Object.freeze([
            { minPlayers: 2,  maxPlayers: 6,  decks: 1 },
            { minPlayers: 7,  maxPlayers: 12, decks: 2 },
            { minPlayers: 13, maxPlayers: 15, decks: 3 }
        ])
    });

    /* ========================================================================
     *  2. HELPERS PURS
     * ===================================================================== */

    function cardPoints(card) {
        if (!card) return 0;
        if (CONFIG.POINTS[card.value] !== undefined) return CONFIG.POINTS[card.value];
        const n = parseInt(card.value, 10);
        return Number.isFinite(n) ? n : 0;
    }

    function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function buildDeck(numDecks) {
        const d = [];
        for (let k = 0; k < numDecks; k++) {
            for (const s of CONFIG.SUITS) {
                for (const v of CONFIG.VALUES) {
                    d.push({ suit: s, value: v, isRed: (s === '♥️' || s === '♦️') });
                }
            }
        }
        return shuffle(d);
    }

    function computeRequiredDecks(playerCount) {
        for (const tier of CONFIG.DECK_AUTO_TIERS) {
            if (playerCount >= tier.minPlayers && playerCount <= tier.maxPlayers) return tier.decks;
        }
        return 1;
    }

    function getPlayerById(state, playerId) {
        return state.players.find(p => p.id === playerId) || null;
    }
    function getActivePlayers(state) {
        return state.players.filter(p => !p.eliminated);
    }
    function topDiscard(state) {
        return state.discardPile[state.discardPile.length - 1] || null;
    }
    function sortHand(player) {
        player.hand.sort((a, b) => {
            const sA = CONFIG.SUITS.indexOf(a.suit);
            const sB = CONFIG.SUITS.indexOf(b.suit);
            if (sA !== sB) return sA - sB;
            return CONFIG.VALUES.indexOf(a.value) - CONFIG.VALUES.indexOf(b.value);
        });
    }

    /* ========================================================================
     *  3. CRÉATION DE PARTIE
     * ===================================================================== */

    function createGame(opts) {
        const o = opts || {};
        const players = (o.players || []).map(p => ({
            id: p.id,
            name: String(p.name || `Joueur-${p.id}`),
            isHuman: !!p.isHuman,
            hand: [],
            eliminated: false,
            consecutiveWins: 0
        }));

        if (players.length < CONFIG.PLAYER_RANGE.MIN || players.length > CONFIG.PLAYER_RANGE.MAX) {
            throw new Error(`Nombre de joueurs invalide : ${players.length}.`);
        }
        const ids = new Set(players.map(p => p.id));
        if (ids.size !== players.length) throw new Error('IDs de joueurs non uniques.');

        const numDecks = Number.isFinite(o.numDecks) && o.numDecks > 0
            ? Math.floor(o.numDecks)
            : computeRequiredDecks(players.length);

        const cardsPerDeck = Math.min(
            CONFIG.MAX_CARDS_PER_DECK,
            Math.max(CONFIG.MIN_CARDS_PER_DECK, o.cardsPerDeck || CONFIG.MAX_CARDS_PER_DECK)
        );
        const maxCards = numDecks * cardsPerDeck;

        let cardsPerPlayer = Math.floor(o.cardsPerPlayer || 6);
        cardsPerPlayer = Math.min(maxCards, Math.max(CONFIG.MIN_CARDS_PER_DECK, cardsPerPlayer));

        const scores = {};
        players.forEach(p => (scores[p.id] = 0));

        return {
            config: { numDecks, cardsPerDeck, cardsPerPlayer, maxCards, playerCount: players.length },
            players, scores,
            deck: [], discardPile: [],
            currentPlayerIdx: 0,
            direction: -1,
            activeSuit: null,
            pendingAceConstraint: false,
            roundNumber: 0,
            roundEnded: true,
            gameOver: false,
            lastPlayedCard: null,
            dealerId: null,
            journal: []
        };
    }

    /* ========================================================================
     *  4. DÉMARRAGE D'UNE MANCHE
     * ===================================================================== */

    function startRound(state) {
        const events = [];
        const active = getActivePlayers(state);
        if (active.length < 2) {
            state.gameOver = true;
            state.roundEnded = true;
            events.push({ type: 'GAME_OVER', ranking: buildRanking(state) });
            return { valid: false, state, events };
        }

        state.roundNumber++;
        state.roundEnded = false;
        state.direction = -1;
        state.activeSuit = null;
        state.pendingAceConstraint = false;
        state.lastPlayedCard = null;

        let dealer;
        if (state.roundNumber === 1) {
            dealer = active[Math.floor(Math.random() * active.length)];
        } else {
            const maxScore = Math.max(...active.map(p => state.scores[p.id]));
            const candidates = active.filter(p => state.scores[p.id] === maxScore);
            dealer = candidates[Math.floor(Math.random() * candidates.length)];
        }
        state.dealerId = dealer.id;
        const dealerIdx = state.players.findIndex(p => p.id === dealer.id);

        state.deck = buildDeck(state.config.numDecks);
        state.discardPile = [];
        const nCards = Math.min(state.config.cardsPerPlayer, state.config.maxCards);

        active.forEach(p => {
            p.hand = [];
            for (let i = 0; i < nCards; i++) {
                if (state.deck.length === 0) refillDeckFromDiscard(state);
                if (state.deck.length > 0) p.hand.push(state.deck.pop());
            }
            sortHand(p);
            events.push({ type: 'DEAL_HAND', playerId: p.id, count: p.hand.length });
        });

        if (state.deck.length === 0) refillDeckFromDiscard(state);
        const startingCard = state.deck.pop();
        state.discardPile.push(startingCard);
        state.lastPlayedCard = startingCard;
        events.push({ type: 'STARTING_CARD', card: startingCard });

        const firstIdx = findNextActiveIdx(state, dealerIdx, -1);
        let firstTurnIdx = firstIdx;
        const effectEvents = applyStartingCardEffect(state, startingCard, dealerIdx);
        effectEvents.forEach(e => events.push(e));

        if (startingCard.value === '10') {
            firstTurnIdx = findNextActiveIdx(state, dealerIdx, 1);
        } else if (startingCard.value === 'J') {
            firstTurnIdx = findNextActiveIdx(state, firstIdx, state.direction);
            events.push({ type: 'PLAYER_SKIPPED', playerId: state.players[firstIdx].id });
        } else if (startingCard.value === '2') {
            const n = getActivePlayers(state).length;
            if (n <= 3) firstTurnIdx = dealerIdx;
            else firstTurnIdx = findNextActiveIdx(state, dealerIdx, state.direction * 3);
        }

        state.currentPlayerIdx = firstTurnIdx;
        events.push({ type: 'TURN_CHANGED', playerId: state.players[firstTurnIdx].id });

        return { valid: true, state, events };
    }

    function applyStartingCardEffect(state, card, dealerIdx) {
        const events = [];
        const active = getActivePlayers(state);
        const n = active.length;
        const firstIdx = findNextActiveIdx(state, dealerIdx, -1);

        switch (card.value) {
            case 'A': {
                state.pendingAceConstraint = true;
                events.push({ type: 'ACE_LOCK_APPLIED', victimId: state.players[firstIdx].id });
                break;
            }
            case '10': {
                state.direction = 1;
                events.push({ type: 'DIRECTION_REVERSED', direction: 1 });
                break;
            }
            case 'J': break;
            case '2': {
                if (n === 2) {
                    const victim = state.players[firstIdx];
                    drawN(state, victim, 3, events);
                    events.push({ type: 'ATTACK_2', victims: [{ id: victim.id, count: 3 }] });
                } else if (n === 3) {
                    const v1 = state.players[firstIdx];
                    const v2 = state.players[findNextActiveIdx(state, firstIdx, -1)];
                    drawN(state, v1, 2, events);
                    drawN(state, v2, 1, events);
                    events.push({ type: 'ATTACK_2', victims: [{ id: v1.id, count: 2 }, { id: v2.id, count: 1 }] });
                } else {
                    const v1 = state.players[firstIdx];
                    const v2 = state.players[findNextActiveIdx(state, firstIdx, -1)];
                    drawN(state, v1, 2, events);
                    drawN(state, v2, 1, events);
                    events.push({ type: 'ATTACK_2', victims: [{ id: v1.id, count: 2 }, { id: v2.id, count: 1 }] });
                }
                break;
            }
            case '8': {
                const randomSuit = CONFIG.SUITS[Math.floor(Math.random() * 4)];
                state.activeSuit = randomSuit;
                events.push({ type: 'SUIT_IMPOSED', suit: randomSuit, by: state.players[dealerIdx].id });
                break;
            }
        }
        return events;
    }

    /* ========================================================================
     *  5. RÈGLES — LISIBILITÉ ET COUPS VALIDES
     * ===================================================================== */

    function isCardPlayable(state, card) {
        const top = topDiscard(state);
        if (!card) return false;
        if (state.pendingAceConstraint) return card.value === 'A';
        if (state.activeSuit) return card.suit === state.activeSuit || card.value === '8';
        if (card.value === '8') return true;
        if (!top) return true;
        return card.suit === top.suit || card.value === top.value;
    }

    function getPlayableCards(state, playerId) {
        const p = getPlayerById(state, playerId);
        if (!p) return [];
        return p.hand
            .map((card, idx) => ({ card, idx }))
            .filter(x => isCardPlayable(state, x.card));
    }

    /* ========================================================================
     *  6. ORDRE DU JEU
     * ===================================================================== */

    function findNextActiveIdx(state, fromIdx, dir) {
        const total = state.players.length;
        let idx = fromIdx;
        let safety = 0;
        do {
            idx = (idx + dir + total) % total;
            safety++;
        } while (state.players[idx].eliminated && safety < total * 4);
        return idx;
    }

    function getNextActivePlayer(state, fromIdx, steps) {
        let idx = fromIdx;
        let count = 0;
        const s = steps || 1;
        let safety = 0;
        while (count < s && safety < state.players.length * 4) {
            idx = (idx + state.direction + state.players.length) % state.players.length;
            if (!state.players[idx].eliminated) count++;
            safety++;
        }
        return { player: state.players[idx], idx };
    }

    function advanceTurnIdx(state, steps) {
        let idx = state.currentPlayerIdx;
        let moved = 0;
        const s = steps || 1;
        let safety = 0;
        while (moved < s && safety < state.players.length * 4) {
            idx = (idx + state.direction + state.players.length) % state.players.length;
            if (!state.players[idx].eliminated) moved++;
            safety++;
        }
        state.currentPlayerIdx = idx;
    }

    /* ========================================================================
     *  7. ACTIONS
     * ===================================================================== */

    function playCard(state, playerId, cardIndex) {
        const events = [];
        const playerIdx = state.players.findIndex(p => p.id === playerId);

        if (state.roundEnded || state.gameOver) return { valid: false, state, events, reason: 'ROUND_ENDED' };
        if (playerIdx !== state.currentPlayerIdx) return { valid: false, state, events, reason: 'NOT_YOUR_TURN' };

        const player = state.players[playerIdx];
        const card = player.hand[cardIndex];
        if (!card) return { valid: false, state, events, reason: 'INVALID_CARD_INDEX' };
        if (!isCardPlayable(state, card)) return { valid: false, state, events, reason: 'CARD_NOT_PLAYABLE' };

        const wasConstrained = state.pendingAceConstraint;
        const playedCard = { ...card };

        player.hand.splice(cardIndex, 1);
        state.discardPile.push(playedCard);
        state.lastPlayedCard = playedCard;
        events.push({ type: 'CARD_PLAYED', playerId: player.id, card: playedCard });

        if (wasConstrained) {
            state.pendingAceConstraint = false;
            events.push({ type: 'ACE_LOCK_RELEASED', byPlayerId: player.id });
        } else if (playedCard.value === 'A') {
            state.pendingAceConstraint = true;
            const next = getNextActivePlayer(state, playerIdx, 1);
            events.push({ type: 'ACE_LOCK_APPLIED', victimId: next.player.id });
        }

        if (state.activeSuit && playedCard.suit === state.activeSuit) state.activeSuit = null;

        const n = getActivePlayers(state).length;
        const isLastCard = player.hand.length === 0;
        let lastCardViolation = false;
        if (isLastCard) {
            if (playedCard.value === '2' && (n === 2 || n === 3)) lastCardViolation = true;
            if ((playedCard.value === '10' || playedCard.value === 'J') && n === 2) lastCardViolation = true;
        }

        if (lastCardViolation) {
            if (playedCard.value === '2') applyTwoEffect(state, playerIdx, events);
            drawN(state, player, 1, events);
            events.push({ type: 'LAST_CARD_FORBIDDEN', playerId: player.id, card: playedCard });
            advanceTurnIdx(state, 1);
            events.push({ type: 'TURN_CHANGED', playerId: state.players[state.currentPlayerIdx].id });
            return { valid: true, state, events };
        }

        if (player.hand.length === 0) {
            state.roundEnded = true;
            const summary = resolveRoundEnd(state, player.id, playedCard);
            events.push({ type: 'ROUND_ENDED', winnerId: player.id, lastCard: playedCard, summary });
            if (state.gameOver) events.push({ type: 'GAME_OVER', ranking: buildRanking(state) });
            return { valid: true, state, events };
        }

        const effects = applyCardEffects(state, playedCard, playerIdx);
        effects.forEach(e => events.push(e));

        const needsSuitChoice = playedCard.value === '8' && player.isHuman;
        if (!needsSuitChoice) {
            events.push({ type: 'TURN_CHANGED', playerId: state.players[state.currentPlayerIdx].id });
        }
        return { valid: true, state, events, needsSuitChoice };
    }

    function drawCard(state, playerId) {
        const events = [];
        const playerIdx = state.players.findIndex(p => p.id === playerId);
        if (state.roundEnded || state.gameOver) return { valid: false, state, events, reason: 'ROUND_ENDED' };
        if (playerIdx !== state.currentPlayerIdx) return { valid: false, state, events, reason: 'NOT_YOUR_TURN' };

        const player = state.players[playerIdx];
        const wasConstrained = state.pendingAceConstraint;
        drawN(state, player, 1, events);
        if (wasConstrained) {
            state.pendingAceConstraint = false;
            events.push({ type: 'ACE_LOCK_RELEASED', byPlayerId: player.id, viaDraw: true });
        }
        advanceTurnIdx(state, 1);
        events.push({ type: 'TURN_CHANGED', playerId: state.players[state.currentPlayerIdx].id });
        return { valid: true, state, events };
    }

    function chooseSuit(state, playerId, suit) {
        const events = [];
        if (!CONFIG.SUITS.includes(suit)) return { valid: false, state, events, reason: 'INVALID_SUIT' };
        const playerIdx = state.players.findIndex(p => p.id === playerId);
        if (playerIdx !== state.currentPlayerIdx) return { valid: false, state, events, reason: 'NOT_YOUR_TURN' };

        state.activeSuit = suit;
        events.push({ type: 'SUIT_IMPOSED', suit, by: playerId });
        advanceTurnIdx(state, 1);
        events.push({ type: 'TURN_CHANGED', playerId: state.players[state.currentPlayerIdx].id });
        return { valid: true, state, events };
    }

    /* ========================================================================
     *  8. EFFETS DES CARTES
     * ===================================================================== */

    function applyCardEffects(state, card, playerIdx) {
        const events = [];
        const active = getActivePlayers(state);
        const n = active.length;

        switch (card.value) {
            case '8': {
                const player = state.players[playerIdx];
                if (player.isHuman) return events;
                const counts = { '♥️': 0, '♦️': 0, '♣️': 0, '♠️': 0 };
                player.hand.forEach(c => { counts[c.suit] = (counts[c.suit] || 0) + 1; });
                const chosen = Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b);
                state.activeSuit = chosen;
                events.push({ type: 'SUIT_IMPOSED', suit: chosen, by: player.id });
                advanceTurnIdx(state, 1);
                break;
            }
            case '2': applyTwoEffect(state, playerIdx, events); break;
            case '10': {
                state.direction *= -1;
                events.push({ type: 'DIRECTION_REVERSED', direction: state.direction });
                if (n === 2) state.currentPlayerIdx = playerIdx;
                else advanceTurnIdx(state, 1);
                break;
            }
            case 'J': {
                const skipped = getNextActivePlayer(state, playerIdx, 1);
                events.push({ type: 'PLAYER_SKIPPED', playerId: skipped.player.id });
                if (n === 2) state.currentPlayerIdx = playerIdx;
                else advanceTurnIdx(state, 2);
                break;
            }
            case 'A': advanceTurnIdx(state, 1); break;
            default: advanceTurnIdx(state, 1); break;
        }
        return events;
    }

    function applyTwoEffect(state, playerIdx, events) {
        const active = getActivePlayers(state);
        const n = active.length;

        if (n === 2) {
            const v = getNextActivePlayer(state, playerIdx, 1);
            drawN(state, v.player, 3, events);
            events.push({ type: 'ATTACK_2', victims: [{ id: v.player.id, count: 3 }] });
            state.currentPlayerIdx = playerIdx;
            return;
        }
        if (n === 3) {
            const v1 = getNextActivePlayer(state, playerIdx, 1);
            const v2 = getNextActivePlayer(state, playerIdx, 2);
            drawN(state, v1.player, 2, events);
            drawN(state, v2.player, 1, events);
            events.push({ type: 'ATTACK_2', victims: [{ id: v1.player.id, count: 2 }, { id: v2.player.id, count: 1 }] });
            state.currentPlayerIdx = playerIdx;
            return;
        }
        const v1 = getNextActivePlayer(state, playerIdx, 1);
        const v2 = getNextActivePlayer(state, playerIdx, 2);
        drawN(state, v1.player, 2, events);
        drawN(state, v2.player, 1, events);
        events.push({ type: 'ATTACK_2', victims: [{ id: v1.player.id, count: 2 }, { id: v2.player.id, count: 1 }] });
        state.currentPlayerIdx = playerIdx;
        advanceTurnIdx(state, 3);
    }

    /* ========================================================================
     *  9. PIOCHE / DÉFAUSSE
     * ===================================================================== */

    function refillDeckFromDiscard(state) {
        if (state.discardPile.length <= 1) return;
        const topCard = state.discardPile.pop();
        state.deck = shuffle(state.discardPile.slice());
        state.discardPile = [topCard];
    }

    function drawN(state, player, qty, events) {
        let drawn = 0;
        for (let i = 0; i < qty; i++) {
            if (state.deck.length === 0) refillDeckFromDiscard(state);
            if (state.deck.length === 0) break;
            player.hand.push(state.deck.pop());
            drawn++;
        }
        sortHand(player);
        if (drawn > 0) events.push({ type: 'DRAWN', playerId: player.id, count: drawn });
        return drawn;
    }

    /* ========================================================================
     *  10. FIN DE MANCHE
     * ===================================================================== */

    function resolveRoundEnd(state, winnerId, lastCard) {
        const events = [];
        const summary = {
            winnerId, lastCard,
            bonuses: [], penalties: [], graced: [], eliminated: []
        };

        if (lastCard && lastCard.value === '8') {
            state.scores[winnerId] += CONFIG.EIGHT_BONUS_ON_WIN;
            summary.bonuses.push({ playerId: winnerId, type: 'EIGHT_WIN', amount: CONFIG.EIGHT_BONUS_ON_WIN });
        }

        state.players.forEach(p => { if (p.id !== winnerId) p.consecutiveWins = 0; });
        const winner = getPlayerById(state, winnerId);
        if (winner) winner.consecutiveWins = (winner.consecutiveWins || 0) + 1;

        if (winner && winner.consecutiveWins >= CONFIG.THRESHOLD.STREAK_WIN_COUNT) {
            state.scores[winnerId] += CONFIG.THRESHOLD.STREAK_WIN_REWARD;
            summary.bonuses.push({ playerId: winnerId, type: 'STREAK_3', amount: CONFIG.THRESHOLD.STREAK_WIN_REWARD });
            winner.consecutiveWins = 0;
        }

        state.players.forEach(p => {
            if (p.id === winnerId || p.eliminated) return;
            let pts = 0;
            p.hand.forEach(c => { pts += cardPoints(c); });
            state.scores[p.id] += pts;
            summary.penalties.push({ playerId: p.id, amount: pts, cards: p.hand.slice() });
        });

        state.players.forEach(p => {
            if (p.eliminated) return;
            const score = state.scores[p.id];
            if (score === CONFIG.THRESHOLD.GRACE_TRIGGER) {
                state.scores[p.id] -= CONFIG.THRESHOLD.GRACE_AMOUNT;
                summary.graced.push({ playerId: p.id, from: score, to: state.scores[p.id] });
                events.push({ type: 'PLAYER_GRACED', playerId: p.id, from: score, to: state.scores[p.id] });
            }
            if (state.scores[p.id] >= CONFIG.THRESHOLD.ELIMINATION) {
                p.eliminated = true;
                p.hand = [];
                summary.eliminated.push({ playerId: p.id, score: state.scores[p.id] });
                events.push({ type: 'PLAYER_ELIMINATED', playerId: p.id, score: state.scores[p.id] });
            }
        });

        const survivors = getActivePlayers(state);
        if (survivors.length <= 1) {
            state.gameOver = true;
            summary.gameOver = true;
            summary.finalWinnerId = survivors[0] ? survivors[0].id : null;
            summary.ranking = buildRanking(state);
        }
        return summary;
    }

    function buildRanking(state) {
        return [...state.players]
            .sort((a, b) => {
                if (!a.eliminated && b.eliminated) return -1;
                if (a.eliminated && !b.eliminated) return 1;
                return state.scores[a.id] - state.scores[b.id];
            })
            .map((p, i) => ({
                rank: i + 1,
                id: p.id,
                name: p.name,
                isHuman: p.isHuman,
                eliminated: p.eliminated,
                score: state.scores[p.id]
            }));
    }

    /* ========================================================================
     *  11. REPÊCHAGE EN CASCADE (Option B)
     * ===================================================================== */

    function computeRepêchageOrder(candidates) {
        const list = candidates.map(c => ({ ...c }));
        list.sort((a, b) => {
            const distA = Math.abs(CONFIG.THRESHOLD.ELIMINATION - a.totalScore);
            const distB = Math.abs(CONFIG.THRESHOLD.ELIMINATION - b.totalScore);
            if (distA !== distB) return distA - distB;
            if (a.lastHandPoints !== b.lastHandPoints) return a.lastHandPoints - b.lastHandPoints;
            if (a.lastHandCount !== b.lastHandCount) return a.lastHandCount - b.lastHandCount;
            return 0;
        });

        const groups = [];
        let current = null;
        for (const c of list) {
            if (!current) { current = [c]; continue; }
            const last = current[current.length - 1];
            const distLast = Math.abs(CONFIG.THRESHOLD.ELIMINATION - last.totalScore);
            const distCurr = Math.abs(CONFIG.THRESHOLD.ELIMINATION - c.totalScore);
            if (distLast === distCurr && last.lastHandPoints === c.lastHandPoints && last.lastHandCount === c.lastHandCount) {
                current.push(c);
            } else {
                groups.push(current);
                current = [c];
            }
        }
        if (current) groups.push(current);

        return list.map(c => {
            const tieGroup = groups.find(g => g.includes(c));
            return {
                ...c,
                tieBreak: tieGroup && tieGroup.length > 1
                    ? { needed: true, group: tieGroup.map(x => x.id), format: tieGroup.length === 2 ? '1v1' : 'dedicated' }
                    : { needed: false }
            };
        });
    }

    /* ========================================================================
     *  12. API PUBLIQUE
     * ===================================================================== */

    const Engine8Master = {
        CONFIG, cardPoints, computeRequiredDecks,
        createGame, startRound, buildDeck,
        isCardPlayable, getPlayableCards, getNextActivePlayer, findNextActiveIdx,
        playCard, drawCard, chooseSuit,
        resolveRoundEnd, buildRanking, computeRepêchageOrder,
        sortHand, getPlayerById, getActivePlayers, topDiscard
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = Engine8Master;
    else global.Engine8Master = Engine8Master;

})(typeof window !== 'undefined' ? window : globalThis);