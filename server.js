/*
ollame-rocket-chat-bot is a AI chat bot for Rocket.Chat that connect and use
ollam server.
Copyright (C) (2024) MINES PARIS
Copyright (C) (2024) Benoît Gschwind <benoit.gschwind@mines-paristech.fr>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const dotenv = require('dotenv').config()

const { driver, method_cache, api } = require('@rocket.chat/sdk');

const OLLAMA_HOST = process.env.OLLAMA_URL.normalize().toLowerCase();

// Environment setup (consider using environment variables)
const HOST = process.env.ROCKETCHAT_URL.normalize().toLowerCase();
const USER = process.env.ROCKETCHAT_USER;
const PASS = process.env.ROCKETCHAT_PASSWORD;

// Store Meteor API userId
var user_id;

// Global switch to disable bot dialogue
var is_enable = true;
var status_message = "Available";
var admin_set = new Set(process.env.ADMIN_USERS.split(','));

class UserContext {
	constructor(rid) {
		this.rid = rid;
		this.model = "llama3.1:latest";
		this.messages = new Array();
	}

	push(msg) {
		this.messages.push(msg);
	}

	pop() {
		return this.messages.pop();
	}

	clear() {
		this.messages = new Array();
	}

	set_model(model) {
		this.model = model;
	}
};

class UserMap extends Map {
	get(rid) {
		if (!this.has(rid)) {
			this.set(rid, new UserContext(rid));
		}
		return super.get(rid);
	}
}

function parse_cmd(str) {

	let args = new Array();
	let nxt_args = "";

	function drop(x) { }
	function push(x) { nxt_args += x; }
	function push_args(x) { args.push(nxt_args); nxt_args = ""; }

	const machine = new Map();

	machine.set("state0", [
		[/\s/, ["state0", drop]],
		[/"/,  ["state2", drop]],
		[/./,  ["state1", push]]
	]);

	machine.set("state1", [
		[/\s/, ["state0", push_args]],
		[/\\/, ["state3", drop]],
		[/./,  ["state1", push]]
	]);

	machine.set("state2", [
		[/"/,  ["state0", push_args]],
		[/\\/, ["state4", drop]],
		[/./,  ["state2", push]]
	]);

	machine.set("state3", [
		[/./, ["state1", push]]
	]);

	machine.set("state4", [
		[/./, ["state2", push]]
	]);

	let state = machine.get("state0")
	for (const s of (str+" ")) {
		for (let v of state) {
			if (v[0].test(s)) {
				v[1][1](s);
				state = machine.get(v[1][0]);
				break;
			}
		}
	}
	return args;
}

// Bot configuration
async function runbot() {
	try {
		// loggin the bot to Meteo interface
		await driver.connect({ host: HOST });
		user_id = await driver.login({ username: USER, password: PASS });

		console.log('userId: ', user_id);

		// login the user to the REST API
		// By default it use process.env.ROCKETCHAT_{USER,PASSWORD}
		await api.login();

		const subscribed = await driver.subscribeToMessages();
		console.log('subscribed');

		const msgloop = await driver.reactToMessages(processMessages);
		console.log('connected and waiting for messages');

		// Set user status to online
		await api.post("users.setStatus", {status: "online", userId: user_id});
		console.log('Greeting message sent');
	} catch (error) {
		console.error("Error:", error);
	}
};

let messages_history = new UserMap();

const command_handlers = new Map();

function command_handler(name, need_admin) {
	return function (doc, value) {
		console.log(`Register command: ${name}`);
		if (need_admin) {
			command_handlers.set("!"+name, async function (msg, cmd) {
				if (!admin_set.has(msg.u.username)) {
					await send_message(msg.rid, "This command can be used only by admins user");
					return;
				}
				return value(msg, cmd);
			});
		} else {
			command_handlers.set("!"+name, value);
		}
		command_handlers.get("!"+name).name = value.name;
		command_handlers.get("!"+name).doc = doc + (need_admin?" _(admin only)_":"");
		return value;
	}
}

async function send_message(rid, msg) {
	try {
		const sentmsg = await driver.sendToRoomId(msg, rid);
	} catch (error) {
		console.error("Error sending message:", error);
	}
}

command_handler("status")
("Show status of the bot",
async function do_status(msg, args) {
	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, true]);

	const ctx = messages_history.get(msg.rid);
	let response = `I'm offline and I using _${ctx.model}_\n`;
	if (is_enable) {
		response = `I'm online and I using _${ctx.model}_\n`;
	}

	response += `My status is : ${status_message}\n`;

	let j = await (await fetch(`${OLLAMA_HOST}/api/ps`)).json();
	if (j.models.length > 0) {
		response += 'Running models:\n';
		for (let m of j.models) {
			response += `- ${m.name} (${m.size/1000000000}GB)\n`;
		}
	} else {
		response += "No model are running.\n";
	}

	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, false]);
	await send_message(msg.rid, response);
});

command_handler("enable", true)
("Put the bot online",
async function do_enable(msg, args) {
	if (!admin_set.has(msg.u.username)) {
		await send_message(msg.rid, "This command can be used only by admins user");
		return;
	}
	is_enable = true;
	let margs = {status: "online", userId: user_id};
	if (args.length>1) {
		status_message = args[1];
		margs.message = args[1];
	}
	await api.post("users.setStatus", margs);
	await send_message(msg.rid, "I'm online");
});

command_handler("disable", true)
("Put the bot offline",
async function do_disable(msg, args) {
	if (!admin_set.has(msg.u.username)) {
		await send_message(msg.rid, "This command can be used only by admins user");
		return;
	}
	is_enable = false;
	messages_history = new UserMap();
	let margs = {status: "offline", userId: user_id};
	if (args.length>1) {
		status_message = args[1];
		margs.message = args[1];
	}
	await api.post("users.setStatus", margs);
	await send_message(msg.rid, "I'm offline");
});

command_handler("retry")
("Ask to regenerate a new ankser",
async function do_retry(msg, cmd) {
	/* remove last generated response from history and remake the request */

	if (!is_enable) {
		await send_message(msg.rid, "I'm offline, this message is ignored");
		return;
	}

	const ctx = messages_history.get(msg.rid);

	if (ctx.messages.length < 1) {
		return;
	}

	ctx.pop()

	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, true]);
	const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		body: JSON.stringify({
			model: ctx.model,
			stream: false,
			messages: ctx.messages
		})
	});

	const j = await r.json();
	ctx.push(j.message);

	await send_message(msg.rid, j.message.content);

	if (j.message.images) {
		await send_message(mgs.rid, "Some images found");
	}

	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, false]);
})

command_handler("help")
("Print available command",
async function do_help(msg, cmd) {
	let response = 'Available commands:\n';
	for (const [k, v] of command_handlers) {
		response += `- \`${k}\`: ${v.doc}\n`;
	}
	await send_message(msg.rid, response);

});

async function do_chat(msg) {

	if (!is_enable) {
		await send_message(msg.rid, "I'm offline, this message is ignored");
		return;
	}

	const ctx = messages_history.get(msg.rid);

	console.log(msg);

	let user_message = {"role": "user", "content": msg.msg};

	if (msg.attachments) {
		let images = new Array();
		let description = "";
		for (let a of msg.attachments) {
			if ((new Set(['image/png', 'image/jpeg'])).has(a.image_type)) {
				const r = await fetch(`https://${HOST}${a.image_url}`, {headers: api.getHeaders(true)});
				const data = await r.arrayBuffer();
				console.log(data);
				const img = Buffer.from(data).toString('base64');
				images.push(img);
				description += "\n"+a.description;
			} else {
				await send_message(msg.rid, `Unknown attachments type: ${a.image_type}`);
			}
		}

		if (images.length > 0) {
			user_message.content += description;
			user_message.images = images;
		}
	}

	ctx.push(user_message);

	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, true]);
	const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		body: JSON.stringify({
			model: ctx.model,
			stream: false,
			messages: ctx.messages
		})
	});

	const j = await r.json();
	ctx.push(j.message);

	await send_message(msg.rid, j.message.content);

	if (j.message.images) {
		await send_message(mgs.rid, "Some images found");
	}

	await driver.asyncCall("stream-notify-room", [`${msg.rid}/typing`, false]);

};

command_handler("clear")
("Clear history",
async function do_clear(msg) {
	messages_history.get(msg.rid).clear();
});

command_handler("model", true)
("List or change the current model",
async function do_model(msg, args) {
	if (args.length == 1) {
		await do_tags(msg);
	} else if (args.length == 2) {
		// Check if the model is available
		let j = await (await fetch(`${OLLAMA_HOST}/api/tags`)).json();
		let models_set = new Set();
		for (let m of j.models) {
			models_set.add(m.name);
		}
		if (models_set.has(args[1])) {
			messages_history.get(msg.rid).set_model(args[1]);
			await send_message(msg.rid, `New model is _${args[1]}_`);
		} else {
			await send_message(msg.rid, `Unkown model _${args[1]}_`);
		}
	} else {
		await send_message(msg.rdid, "Error: Invalid arguments !");
	}
});

async function do_tags(message) {
	let j = await (await fetch(`${OLLAMA_HOST}/api/tags`)).json();
	let response = 'Available models are:\n';
	for (let m of j.models) {
		response += `- ${m.name}\n`;
	}
	response += `\ncurrent model: *${messages_history.get(message.rid).model}*\n`;
	try {
		const sentmsg = await driver.sendToRoomId(response, message.rid);
	} catch (error) {
		console.error("Error sending message:", error);
	}
}

// Process messages
const processMessages = async (err, message, messageOptions) => {
	if (!err) {
		if (message.u._id == user_id) return;
		const roomname = await driver.getRoomName(message.rid);
		console.log('got message ' + message.msg);
		console.log(message, messageOptions);

		if (messageOptions.roomType == 'd') {
			if (message.msg.length >= 1 && message.msg[0] == '!') {
				// TODO: handle quote and escape sequences
				let cmd = parse_cmd(message.msg);
				if (command_handlers.has(cmd[0])) {
					console.log(cmd);
					await command_handlers.get(cmd[0])(message, cmd);
				} else {
					await send_message(message.rid, `Command not found: ${cmd[0]}`);
				}
			} else {
				await do_chat(message);
			}
		}
	} else {
		console.error("Get an error:", err);
	}
};


console.log(command_handlers)
runbot()
