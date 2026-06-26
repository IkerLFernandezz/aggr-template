require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

// ============================================================
//  CONFIGURACIÓN
// ============================================================
const COOLDOWN_MS = 3 * 60 * 1000;      // 1 solicitud cada 3 min por usuario y nivel
const REGISTRO_PATH = path.join(__dirname, 'solicitudes.jsonl');
const FALLOS_PATH = path.join(__dirname, 'solicitudes_fallidas.jsonl');

// Definición de los niveles. Cada uno tiene su canal, su botón y su mensaje.
// Los IDs de canal se leen del .env (tú los configuras).
const NIVELES = {
    vip2: {
        clave: 'vip2',
        nombre: 'VIP 2',
        canalId: process.env.DISCORD_CHANNEL_VIP2,
        color: ButtonStyle.Primary,
        panel:
            '__¿Cómo lo obtengo?__\n\n' +
            'Pulsa en el botón 👇 y te envío el acceso + instrucciones.\n\n',
        botonLabel: 'Solicitar Mapas de Calor',
        confirmacion:
            '🎉 **¡ENHORABUENA!**\n\n' +
            'Acabas de solicitar tu plantilla **(VIP 2)**. En breve será procesada tu solicitud ' +
            'y la recibirás por Discord.\n\n' +
            '📄 El archivo que se te enviará es **individual para cada usuario** y está **prohibida su transferencia**.',
    },
    vip3: {
        clave: 'vip3',
        nombre: ' VIP 3',
        canalId: process.env.DISCORD_CHANNEL_VIP3,
        color: ButtonStyle.Success,
        panel:
            '__¿Cómo lo obtengo?__\n\n' +
            'Pulsa en el botón 👇 y te envío el acceso + instrucciones.\n\n',
        botonLabel: 'Solicitar Indicadores',
        confirmacion:
            '🎉 **¡ENHORABUENA!**\n\n' +
            'Acabas de solicitar tu plantilla **(VIP 3)**. En breve será procesada tu solicitud ' +
            'y la recibirás por Discord.\n\n' +
            '📄 El archivo que se te enviará es **individual para cada usuario** y está **prohibida su transferencia**.',
    },
    // Nuevo: solicitud de ACCESO al VIP 3 (no es una plantilla)
    accesovip3: {
        clave: 'accesovip3',
        nombre: 'Acceso VIP 3',
        canalId: process.env.DISCORD_CHANNEL_ACCESO_VIP3,
        color: ButtonStyle.Success,
        panel:
            'Tienes más de 30.000 USDT en Bitunix? Eso significa que eres una Ballena y puedes entrar en el VIP 3.\n\n' +
            'Solicita aquí abajo 👇 entrar al VIP 3 y tener acceso a Beneficios Secretos.',
        botonLabel: 'Solicitar Acceso al VIP 3',
        confirmacion:
            '🎉 **¡SOLICITUD ENVIADA!**\n\n' +
            'Acabas de solicitar el **acceso al VIP 3**. En breve revisaremos tu solicitud ' +
            'y te daremos acceso a los **Beneficios Secretos**.\n\n' +
            '📨 Nos pondremos en contacto contigo por Discord.',
    },
};

// ============================================================
//  UTILIDADES
// ============================================================

// Escapa los caracteres especiales de MarkdownV2 para que Telegram no falle
function escaparMarkdown(texto) {
    return String(texto).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Guarda una línea JSON en un archivo (append). Nunca lanza: solo loggea.
function guardarRegistro(archivo, objeto) {
    try {
        fs.appendFileSync(archivo, JSON.stringify(objeto) + '\n', 'utf8');
    } catch (err) {
        console.error(`No se pudo escribir en ${archivo}:`, err.message);
    }
}

// Fecha actual formateada DD/MM/AAAA HH:MM (zona horaria de España)
function fechaActual() {
    const ahora = new Date();
    const opciones = {
        timeZone: 'Europe/Madrid',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    };
    // es-ES da formato DD/MM/AAAA, HH:MM
    return ahora.toLocaleString('es-ES', opciones).replace(',', '');
}

// --- Telegram (sin librería, usando fetch nativo) ---
async function enviarTelegram(texto) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: texto,
            parse_mode: 'MarkdownV2',
        }),
    });
    if (!res.ok) {
        const detalle = await res.text();
        throw new Error(`Telegram error ${res.status}: ${detalle}`);
    }
    return res.json();
}

// ============================================================
//  ANTI-SPAM (cooldown por usuario + nivel, en memoria)
// ============================================================
const cooldowns = new Map(); // clave `${userId}:${nivel}` -> timestamp

function comprobarCooldown(userId, nivel) {
    const k = `${userId}:${nivel}`;
    const ahora = Date.now();
    const ultimo = cooldowns.get(k);
    if (ultimo && ahora - ultimo < COOLDOWN_MS) {
        const restanteMs = COOLDOWN_MS - (ahora - ultimo);
        const minutos = Math.ceil(restanteMs / 60000);
        return { permitido: false, minutos };
    }
    return { permitido: true };
}

function marcarCooldown(userId, nivel) {
    cooldowns.set(`${userId}:${nivel}`, Date.now());
}

// Guarda temporalmente lo rellenado, a la espera de confirmación
const pendientesConfirmacion = new Map(); // userId -> datos (incluye nivel)

// ============================================================
//  DISCORD CLIENT
// ============================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('plantilla_vip2')
        .setDescription('Solicita tu plantilla AGGR VIP 2')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('plantilla_vip3')
        .setDescription('Solicita tu plantilla AGGR VIP 3')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('acceso_vip3')
        .setDescription('Solicita acceso al VIP 3')
        .toJSON(),
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(
            process.env.DISCORD_CLIENT_ID,
            process.env.DISCORD_GUILD_ID
        ),
        { body: commands }
    );
    console.log('Comandos registrados.');
}

// Publica (o reutiliza) el panel con botón para un nivel concreto.
async function publicarPanel(nivel) {
    const conf = NIVELES[nivel];
    if (!conf.canalId) {
        console.error(`Falta el ID de canal para ${conf.nombre} (revisa el .env).`);
        return;
    }

    try {
        const canal = await client.channels.fetch(conf.canalId);
        if (!canal) {
            console.error(`No se encontró el canal de ${conf.nombre}.`);
            return;
        }

        const customId = `abrir_${conf.clave}`;

        const mensajes = await canal.messages.fetch({ limit: 30 });
        const existente = mensajes.find(
            (m) =>
                m.author.id === client.user.id &&
                m.components.length > 0 &&
                m.components[0].components?.[0]?.customId === customId
        );

        if (existente) {
            console.log(`Panel de ${conf.nombre} ya existe, se reutiliza.`);
            return;
        }

        const mios = mensajes.filter((m) => m.author.id === client.user.id);
        for (const m of mios.values()) {
            await m.delete().catch(() => { });
        }

        const boton = new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(conf.botonLabel)
            .setStyle(conf.color);

        await canal.send({
            content: conf.panel,
            components: [new ActionRowBuilder().addComponents(boton)],
        });

        console.log(`Panel de ${conf.nombre} publicado.`);
    } catch (err) {
        console.error(`Error publicando el panel de ${conf.nombre}:`, err.message);
    }
}

// ============================================================
//  VALIDACIÓN
// ============================================================

// Valida el UID de Bitunix: exactamente 9 dígitos. Devuelve {ok, valor} o {ok:false, error}
function validarUID(entrada) {
    const limpio = entrada.trim().replace(/\s/g, '');
    if (!/^\d{9}$/.test(limpio)) {
        return { ok: false, error: 'El UID de Bitunix debe tener exactamente 9 números (ejemplo: 123456789).' };
    }
    return { ok: true, valor: limpio };
}

// ============================================================
//  MODAL (solo un campo visible: el UID de Bitunix)
// ============================================================
function construirModal(nivel) {
    const conf = NIVELES[nivel];
    const modal = new ModalBuilder()
        .setCustomId(`form_${conf.clave}`)
        .setTitle(`Solicitud · ${conf.nombre}`);

    const uid = new TextInputBuilder()
        .setCustomId('uid')
        .setLabel('Tu UID de Bitunix (9 números)')
        .setPlaceholder('Ej: 123456789')
        .setStyle(TextInputStyle.Short)
        .setMinLength(9)
        .setMaxLength(9)
        .setRequired(true);

    modal.addComponents(
        new ActionRowBuilder().addComponents(uid)
    );

    return modal;
}

// Devuelve la config de nivel a partir de un customId tipo "abrir_vip2" / "form_accesovip3"
// Importante: comprobar accesovip3 ANTES que vip3, porque "accesovip3" también termina en "vip3".
function nivelDesdeCustomId(customId) {
    if (customId.endsWith('accesovip3')) return NIVELES.accesovip3;
    if (customId.endsWith('vip2')) return NIVELES.vip2;
    if (customId.endsWith('vip3')) return NIVELES.vip3;
    return null;
}

// Conjuntos para identificar fácilmente los customId válidos
const BOTONES_ABRIR = ['abrir_vip2', 'abrir_vip3', 'abrir_accesovip3'];
const MODALES_FORM = ['form_vip2', 'form_vip3', 'form_accesovip3'];

// ============================================================
//  MANEJO DE INTERACCIONES
// ============================================================
client.on('interactionCreate', async (interaction) => {
    try {
        // --- Botones de panel: abrir formulario del nivel ---
        if (interaction.isButton() && BOTONES_ABRIR.includes(interaction.customId)) {
            const conf = nivelDesdeCustomId(interaction.customId);

            // Restricción por canal
            if (interaction.channelId !== conf.canalId) {
                await interaction.reply({
                    content: `❌ Esta solicitud solo puede realizarse en su canal correspondiente.`,
                    ephemeral: true,
                });
                return;
            }

            const cd = comprobarCooldown(interaction.user.id, conf.clave);
            if (!cd.permitido) {
                await interaction.reply({
                    content: `⏳ Ya enviaste una solicitud hace poco. Espera **${cd.minutos} min** antes de enviar otra.`,
                    ephemeral: true,
                });
                return;
            }

            await interaction.showModal(construirModal(conf.clave));
            return;
        }

        // --- Comandos de respaldo ---
        if (interaction.isChatInputCommand() &&
            ['plantilla_vip2', 'plantilla_vip3', 'acceso_vip3'].includes(interaction.commandName)) {

            let conf;
            if (interaction.commandName === 'plantilla_vip2') conf = NIVELES.vip2;
            else if (interaction.commandName === 'plantilla_vip3') conf = NIVELES.vip3;
            else conf = NIVELES.accesovip3;

            if (interaction.channelId !== conf.canalId) {
                await interaction.reply({
                    content: `❌ Este comando solo se puede usar en <#${conf.canalId}>.`,
                    ephemeral: true,
                });
                return;
            }

            const cd = comprobarCooldown(interaction.user.id, conf.clave);
            if (!cd.permitido) {
                await interaction.reply({
                    content: `⏳ Ya enviaste una solicitud hace poco. Espera **${cd.minutos} min** antes de enviar otra.`,
                    ephemeral: true,
                });
                return;
            }

            await interaction.showModal(construirModal(conf.clave));
            return;
        }

        // --- Envío del modal: validar UID y mostrar confirmación ---
        if (interaction.isModalSubmit() && MODALES_FORM.includes(interaction.customId)) {
            const conf = nivelDesdeCustomId(interaction.customId);

            const uidRaw = interaction.fields.getTextInputValue('uid');
            const uidCheck = validarUID(uidRaw);
            if (!uidCheck.ok) {
                await interaction.reply({
                    content:
                        `❌ **UID no válido**\n` +
                        `${uidCheck.error}\n\n` +
                        `🔁 Pulsa otra vez el botón para volver a intentarlo.`,
                    ephemeral: true,
                });
                return;
            }

            // Datos automáticos: nombre de Discord, fecha y nivel (el usuario no los rellena)
            pendientesConfirmacion.set(interaction.user.id, {
                nivel: conf.clave,
                nivelNombre: conf.nombre,
                uid: uidCheck.valor,
                fecha: fechaActual(),
                discordUsername: interaction.user.username,
                discordId: interaction.user.id,
            });

            const confirmar = new ButtonBuilder()
                .setCustomId('confirmar_envio')
                .setLabel('✅ Confirmar y enviar')
                .setStyle(ButtonStyle.Success);

            const cancelar = new ButtonBuilder()
                .setCustomId('cancelar_envio')
                .setLabel('❌ Cancelar')
                .setStyle(ButtonStyle.Danger);

            await interaction.reply({
                content:
                    `## 📋 Revisa tu solicitud (${conf.nombre})\n\n` +
                    `🆔 **UID de Bitunix:** ${uidCheck.valor}\n\n` +
                    '✅ Si el UID es correcto, pulsa **Confirmar**.\n' +
                    '❌ Si te has equivocado, pulsa **Cancelar** y vuelve a empezar.',
                components: [new ActionRowBuilder().addComponents(confirmar, cancelar)],
                ephemeral: true,
            });
            return;
        }

        // --- Cancelar ---
        if (interaction.isButton() && interaction.customId === 'cancelar_envio') {
            pendientesConfirmacion.delete(interaction.user.id);
            await interaction.update({
                content: '❌ Solicitud cancelada. Puedes volver a empezar pulsando el botón de tu canal.',
                components: [],
            });
            return;
        }

        // --- Confirmar y enviar a Telegram ---
        if (interaction.isButton() && interaction.customId === 'confirmar_envio') {
            const datos = pendientesConfirmacion.get(interaction.user.id);
            if (!datos) {
                await interaction.update({
                    content: '❌ La sesión expiró. Vuelve a pulsar el botón de tu canal.',
                    components: [],
                });
                return;
            }

            const conf = NIVELES[datos.nivel];

            const registro = {
                ...datos,
                timestamp: new Date().toISOString(),
            };

            // Guardar SIEMPRE antes de enviar
            guardarRegistro(REGISTRO_PATH, registro);

            const texto =
                `📋 *NUEVA SOLICITUD*\n\n` +
                `🏷️ *Tipo:* ${escaparMarkdown(datos.nivelNombre)}\n` +
                `👤 *Discord:* ${escaparMarkdown(datos.discordUsername)} \\(ID: ${escaparMarkdown(datos.discordId)}\\)\n` +
                `🆔 *UID Bitunix:* ${escaparMarkdown(datos.uid)}\n` +
                `📅 *Fecha solicitud:* ${escaparMarkdown(datos.fecha)}`;

            try {
                await enviarTelegram(texto);

                marcarCooldown(interaction.user.id, datos.nivel);
                pendientesConfirmacion.delete(interaction.user.id);

                await interaction.update({
                    content: conf.confirmacion,
                    components: [],
                });
            } catch (err) {
                console.error('Error enviando a Telegram:', err.message);
                guardarRegistro(FALLOS_PATH, { ...registro, error: err.message });

                await interaction.update({
                    content:
                        '⚠️ Tu solicitud **se ha guardado**, pero hubo un problema técnico al notificarla. ' +
                        'No te preocupes: será procesada igualmente. No hace falta que la reenvíes.',
                    components: [],
                });
            }
            return;
        }
    } catch (err) {
        console.error('Error inesperado en interactionCreate:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ Ha ocurrido un error inesperado. Inténtalo de nuevo.',
                ephemeral: true,
            }).catch(() => { });
        }
    }
});

client.once('ready', async () => {
    console.log(`Bot conectado como ${client.user.tag}`);
    await publicarPanel('vip2');
    await publicarPanel('vip3');
    await publicarPanel('accesovip3');
});

registerCommands().catch(console.error);
client.login(process.env.DISCORD_TOKEN);