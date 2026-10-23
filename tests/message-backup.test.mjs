import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilterProgram } from '../filter-engine.js';
import { processMessageVariants } from '../chat-batch.js';
import { restoreMessageBackups } from '../message-backup.js';
import { classifyChatMessage } from '../message-classifier.js';

const program = compileFilterProgram({
    deleteRules: [{ text: 'very' }],
    replaceRules: [{ from: 'smile', to: 'grin' }],
});

test('batch apply then restore returns every variant to its original', () => {
    const original = {
        mes: 'a very big smile `very`',
        swipe_id: 1,
        swipes: ['first very  one', 'a very big smile `very`', 'untouched'],
    };
    const message = structuredClone(original);

    const applied = processMessageVariants(message, program);
    assert.equal(applied.changed, true);
    assert.equal(message.mes, 'a big grin `very`');
    assert.deepEqual(message.swipes, ['first one', 'a big grin `very`', 'untouched']);

    const restored = restoreMessageBackups(message);
    assert.equal(restored.conflicts, 0);
    assert.deepEqual(message, original);
});

test('a manually edited variant is reported as a conflict, not overwritten', () => {
    const message = { mes: 'very nice', swipes: ['very nice'], swipe_id: 0 };
    processMessageVariants(message, program);
    message.swipes[0] = 'edited by hand';
    message.mes = 'edited by hand';

    const restored = restoreMessageBackups(message);
    assert.equal(restored.conflicts, 1);
    assert.equal(message.swipes[0], 'edited by hand');
});

test('classifier keeps users and system messages out', () => {
    assert.equal(classifyChatMessage({ is_user: true, mes: 'x' }), 'user');
    assert.equal(classifyChatMessage({ is_system: true, mes: 'x' }), 'system');
    assert.equal(classifyChatMessage({ is_system: true, _summarizedHidden: true, swipes: ['x'] }), 'assistant');
    assert.equal(classifyChatMessage({ mes: 'x' }), 'assistant');
});
