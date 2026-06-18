package com.mobius.momo.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mobius.momo.domain.ChatMessage
import com.mobius.momo.domain.MessageAuthor
import com.mobius.momo.domain.Session
import com.mobius.momo.viewmodel.AppScreen
import com.mobius.momo.viewmodel.LoginStep
import com.mobius.momo.viewmodel.MomoAppViewModel
import com.mobius.momo.viewmodel.ThemeMode
import com.mobius.momo.viewmodel.UiState

private val Brand = Color(0xFF5B6CFF)
private val LightBg = Color(0xFFF3F3F4)
private val DarkBg = Color(0xFF111111)
private val LightPanel = Color.White
private val DarkPanel = Color(0xFF1D1D1F)
private val LightBubble = Color.White
private val DarkBubble = Color(0xFF2A2A2D)
private val Muted = Color(0xFF8A8F98)
private val DividerColor = Color(0xFFE7E7E8)
private val Danger = Color(0xFFFF5B5F)
private val Success = Color(0xFF54D17A)

@Composable
fun MomoApp(viewModel: MomoAppViewModel = remember { MomoAppViewModel() }) {
    val state by viewModel.state.collectAsState()
    val systemDark = isSystemInDarkTheme()
    val dark = when (state.themeMode) {
        ThemeMode.System -> systemDark
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }

    MaterialTheme(
        colorScheme = if (dark) darkColorScheme(primary = Brand, background = DarkBg, surface = DarkPanel)
        else lightColorScheme(primary = Brand, background = LightBg, surface = LightPanel),
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = if (dark) DarkBg else LightBg,
        ) {
            Box(Modifier.fillMaxSize()) {
                when (state.screen) {
                    AppScreen.Login -> LoginScreen(state, dark, viewModel)
                    AppScreen.Home -> HomeScreen(state, dark, viewModel)
                    AppScreen.Clones -> CloneListScreen(state, dark, viewModel)
                    AppScreen.Settings -> SettingsScreen(state, dark, viewModel)
                }
                state.toast?.let { ToastBubble(it, dark) }
                if (state.cloneSheetOpen) CloneSheet(state, dark, viewModel)
            }
        }
    }
}

@Composable
private fun LoginScreen(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    val bg = if (dark) DarkBg else LightPanel
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(bg)
            .statusBarsPadding()
            .padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(88.dp))
        AvatarSquare("莫", 80.dp, momoBrush())
        Spacer(Modifier.height(32.dp))
        Text("小莫助理", color = textColor(dark), fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text("登录后与你的 AI 项目助理对话", color = Muted, fontSize = 15.sp)
        Spacer(Modifier.height(72.dp))
        if (state.loginStep == LoginStep.Username) {
            MomoInput(
                value = state.username,
                placeholder = "请输入用户名",
                dark = dark,
                onChange = vm::setUsername,
            )
            Spacer(Modifier.height(22.dp))
            PrimaryButton(if (state.passwordRequired) "下一步" else "登 录", state.loading, vm::nextLoginStep)
        } else {
            MomoInput(
                value = state.password,
                placeholder = "请输入密码",
                dark = dark,
                password = true,
                onChange = vm::setPassword,
            )
            Spacer(Modifier.height(22.dp))
            PrimaryButton("登 录", state.loading, vm::login)
            TextButton(onClick = vm::backToUsername) {
                Text("换一个账号", color = Brand, fontSize = 14.sp)
            }
        }
        Spacer(Modifier.height(28.dp))
        Text("忘记密码？请联系管理员", color = Muted, fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        Text("更多登录方式 ›", color = Brand, fontSize = 15.sp, modifier = Modifier.padding(bottom = 40.dp))
    }
}

@Composable
private fun HomeScreen(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    Column(Modifier.fillMaxSize().background(pageBg(dark)).statusBarsPadding()) {
        TopBar(
            title = state.activeSessionTitle.ifBlank { "我的主小莫" },
            dark = dark,
            left = null,
            right = "☰",
            onRight = vm::toggleMenu,
        )
        Box(Modifier.weight(1f)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { Spacer(Modifier.height(4.dp)) }
                items(state.messages) { message -> MessageRow(message, dark) }
                if (state.typing) {
                    item {
                        Row(verticalAlignment = Alignment.Top) {
                            AvatarSquare("莫", 36.dp, momoBrush())
                            Spacer(Modifier.width(8.dp))
                            TypingBubble(dark)
                        }
                    }
                }
                item { Spacer(Modifier.height(12.dp)) }
            }
            MenuPanel(state.menuOpen, dark, vm)
        }
        ChatInputBar(state, dark, vm)
    }
}

@Composable
private fun CloneListScreen(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    Column(Modifier.fillMaxSize().background(pageBg(dark)).statusBarsPadding()) {
        TopBar("分身列表", dark, left = "‹", onLeft = { vm.navigate(AppScreen.Home) })
        LazyColumn(Modifier.weight(1f).background(panelBg(dark))) {
            items(state.clones.ifEmpty { demoSessions() }) { session ->
                CloneRow(session, dark) { vm.openSession(session) }
                Divider(color = divider(dark), thickness = 0.6.dp)
            }
        }
        Box(
            Modifier.fillMaxWidth().height(64.dp).background(panelBg(dark)).clickable { vm.openCloneSheet() },
            contentAlignment = Alignment.Center,
        ) {
            Text("+  开分身", color = Brand, fontSize = 17.sp)
        }
    }
}

@Composable
private fun SettingsScreen(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    Column(Modifier.fillMaxSize().background(pageBg(dark)).statusBarsPadding()) {
        TopBar("设置", dark, left = "‹", onLeft = { vm.navigate(AppScreen.Home) })
        Spacer(Modifier.height(14.dp))
        SettingSwitch("暗色模式", state.themeMode == ThemeMode.Dark || (state.themeMode == ThemeMode.System && dark), dark) {
            vm.setThemeMode(if (dark) ThemeMode.Light else ThemeMode.Dark)
        }
        SettingSwitch("消息推送", state.pushEnabled, dark, vm::togglePush)
        SettingSwitch("声音播报", state.ttsEnabled, dark, vm::toggleTts)
        Spacer(Modifier.height(14.dp))
        SettingRow("账号", state.user?.displayName ?: state.user?.id.orEmpty(), dark)
        SettingRow("小莫预设", "默认小莫", dark)
        SettingRow("关于", "v0.1.0", dark)
        Spacer(Modifier.height(14.dp))
        Box(
            Modifier.fillMaxWidth().height(56.dp).background(panelBg(dark)).clickable { vm.logout() }.padding(horizontal = 16.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text("退出登录", color = Danger, fontSize = 17.sp)
        }
        Spacer(Modifier.weight(1f))
        Text(
            "小莫助理 · v0.1.0",
            color = Muted,
            fontSize = 13.sp,
            modifier = Modifier.fillMaxWidth().padding(bottom = 42.dp),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun TopBar(
    title: String,
    dark: Boolean,
    left: String? = null,
    right: String? = null,
    onLeft: () -> Unit = {},
    onRight: () -> Unit = {},
) {
    Box(
        Modifier.fillMaxWidth().height(56.dp).background(panelBg(dark)).border(0.5.dp, divider(dark)),
    ) {
        if (left != null) {
            Text(
                left,
                color = textColor(dark),
                fontSize = 28.sp,
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 24.dp).clickable { onLeft() },
            )
        }
        Text(title, color = textColor(dark), fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.Center))
        if (right != null) {
            Text(
                right,
                color = textColor(dark),
                fontSize = 26.sp,
                modifier = Modifier.align(Alignment.CenterEnd).padding(end = 24.dp).clickable { onRight() },
            )
        }
    }
}

@Composable
private fun MessageRow(message: ChatMessage, dark: Boolean) {
    val isUser = message.author == MessageAuthor.User
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!isUser) {
            AvatarSquare("莫", 36.dp, momoBrush())
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (isUser) Alignment.End else Alignment.Start, modifier = Modifier.fillMaxWidth(0.84f)) {
            Box(
                modifier = Modifier
                    .clip(
                        RoundedCornerShape(
                            topStart = if (isUser) 12.dp else 4.dp,
                            topEnd = if (isUser) 4.dp else 12.dp,
                            bottomStart = 12.dp,
                            bottomEnd = 12.dp,
                        ),
                    )
                    .background(if (isUser) Brand else bubbleColor(dark))
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                Text(
                    message.text,
                    color = if (isUser) Color.White else textColor(dark),
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(message.time, color = Muted, fontSize = 11.sp)
        }
        if (isUser) {
            Spacer(Modifier.width(8.dp))
            AvatarSquare("Z", 36.dp, userBrush())
        }
    }
}

@Composable
private fun TypingBubble(dark: Boolean) {
    Row(
        Modifier.clip(RoundedCornerShape(4.dp, 12.dp, 12.dp, 12.dp)).background(bubbleColor(dark)).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(3) { Box(Modifier.size(6.dp).clip(CircleShape).background(Color(0xFFD2D2D4))) }
    }
}

@Composable
private fun ChatInputBar(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    Row(
        modifier = Modifier.fillMaxWidth().height(72.dp).background(panelBg(dark)).imePadding().padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RoundIcon("+", dark) {}
        BasicTextField(
            value = state.input,
            onValueChange = vm::setInput,
            singleLine = true,
            textStyle = TextStyle(color = textColor(dark), fontSize = 15.sp),
            modifier = Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(24.dp)).background(inputBg(dark)).padding(horizontal = 18.dp, vertical = 14.dp),
            decorationBox = { inner ->
                if (state.input.isBlank()) Text("说点什么...", color = Muted, fontSize = 15.sp)
                inner()
            },
        )
        RoundIcon("🎤", dark) {}
        Box(
            Modifier.size(48.dp).clip(CircleShape).background(Brand).clickable { vm.sendHomeMessage() },
            contentAlignment = Alignment.Center,
        ) {
            Text("↑", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun BoxScope.MenuPanel(open: Boolean, dark: Boolean, vm: MomoAppViewModel) {
    AnimatedVisibility(open, modifier = Modifier.align(Alignment.TopEnd)) {
        Column(
            Modifier.padding(12.dp).width(184.dp).clip(RoundedCornerShape(12.dp)).background(panelBg(dark)).border(0.5.dp, divider(dark), RoundedCornerShape(12.dp)),
        ) {
            MenuItem("分身列表") { vm.navigate(AppScreen.Clones) }
            MenuItem("设置") { vm.navigate(AppScreen.Settings) }
            MenuItem("关于") { vm.navigate(AppScreen.Settings) }
        }
    }
}

@Composable
private fun MenuItem(label: String, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(48.dp).clickable { onClick() }.padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
        Text(label, color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
    }
}

@Composable
private fun CloneRow(session: Session, dark: Boolean, onClick: () -> Unit) {
    val roleMain = session.name == "我的主小莫" || session.name.contains("主小莫")
    Row(
        Modifier.fillMaxWidth().height(76.dp).background(panelBg(dark)).clickable { onClick() }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarSquare(if (roleMain) "主" else cloneIndex(session.name), 36.dp, if (roleMain) momoBrush() else cloneBrush(session.name))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(session.name.ifBlank { "分身小莫" }, color = textColor(dark), fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (roleMain) {
                    Spacer(Modifier.width(8.dp))
                    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(Brand).padding(horizontal = 7.dp, vertical = 2.dp)) {
                        Text("主体", color = Color.White, fontSize = 12.sp)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(session.description.ifBlank { "你好呀，我是小莫..." }, color = Muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(session.lastActive.takeIf { it.contains(":") }?.takeLast(8)?.take(5) ?: "10:24", color = Muted, fontSize = 12.sp)
            Spacer(Modifier.height(10.dp))
            Box(Modifier.size(8.dp).clip(CircleShape).background(statusColor(session)))
        }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(64.dp).background(panelBg(dark)).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = textColor(dark), fontSize = 17.sp, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = { onClick() })
    }
    Divider(color = divider(dark), thickness = 0.6.dp)
}

@Composable
private fun SettingRow(label: String, value: String, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().height(64.dp).background(panelBg(dark)).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = textColor(dark), fontSize = 17.sp, modifier = Modifier.weight(1f))
        if (value.isNotBlank()) Text(value, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.width(8.dp))
        Text("›", color = Muted, fontSize = 22.sp)
    }
    Divider(color = divider(dark), thickness = 0.6.dp)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloneSheet(state: UiState, dark: Boolean, vm: MomoAppViewModel) {
    ModalBottomSheet(onDismissRequest = vm::closeCloneSheet, containerColor = panelBg(dark)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("开一个分身小莫", color = textColor(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("分身会在当前小莫任务单下创建独立 Session。", color = Muted, fontSize = 13.sp)
            MomoInput(state.cloneTitle, "分身名称", dark, onChange = vm::setCloneTitle)
            MomoInput(state.cloneDescription, "任务描述", dark, minHeight = 92.dp, onChange = vm::setCloneDescription)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("codex", "opus", "sonnet").forEach { model ->
                    Box(
                        Modifier.clip(RoundedCornerShape(18.dp)).background(if (state.cloneModel == model) Brand else inputBg(dark)).clickable { vm.setCloneModel(model) }.padding(horizontal = 14.dp, vertical = 8.dp),
                    ) {
                        Text(model, color = if (state.cloneModel == model) Color.White else textColor(dark), fontSize = 13.sp)
                    }
                }
            }
            PrimaryButton("+ 创建并启动", state.loading, vm::createClone)
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun MomoInput(
    value: String,
    placeholder: String,
    dark: Boolean,
    password: Boolean = false,
    minHeight: androidx.compose.ui.unit.Dp = 48.dp,
    onChange: (String) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = TextStyle(color = textColor(dark), fontSize = 17.sp),
        visualTransformation = if (password) PasswordVisualTransformation('•') else VisualTransformation.None,
        modifier = Modifier.fillMaxWidth().height(minHeight).clip(RoundedCornerShape(8.dp)).background(inputBg(dark)).border(1.dp, if (focused) Brand else divider(dark), RoundedCornerShape(8.dp)).padding(horizontal = 16.dp, vertical = 13.dp),
        decorationBox = { inner ->
            Box {
                if (value.isBlank()) Text(placeholder, color = Muted, fontSize = 16.sp)
                inner()
            }
        },
    )
}

@Composable
private fun PrimaryButton(label: String, loading: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = !loading,
        modifier = Modifier.fillMaxWidth().height(48.dp),
        shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = Color.White),
    ) {
        Text(if (loading) "请稍候..." else label, fontSize = 17.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AvatarSquare(text: String, size: androidx.compose.ui.unit.Dp, brush: Brush) {
    Box(Modifier.size(size).clip(RoundedCornerShape(size / 4)).background(brush), contentAlignment = Alignment.Center) {
        Text(text, color = Color.White, fontSize = (size.value * 0.48).sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun RoundIcon(label: String, dark: Boolean, onClick: () -> Unit) {
    Box(Modifier.size(48.dp).clip(CircleShape).background(inputBg(dark)).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = Muted, fontSize = 22.sp)
    }
}

@Composable
private fun ToastBubble(text: String, dark: Boolean) {
    Box(Modifier.fillMaxSize().padding(top = 72.dp), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.clip(RoundedCornerShape(22.dp)).background(if (dark) Color(0xEE2A2A2D) else Color(0xEE202124)).padding(horizontal = 16.dp, vertical = 10.dp)) {
            Text(text, color = Color.White, fontSize = 13.sp)
        }
    }
}

private fun textColor(dark: Boolean) = if (dark) Color(0xFFF5F5F7) else Color(0xFF111111)
private fun pageBg(dark: Boolean) = if (dark) DarkBg else LightBg
private fun panelBg(dark: Boolean) = if (dark) DarkPanel else LightPanel
private fun bubbleColor(dark: Boolean) = if (dark) DarkBubble else LightBubble
private fun inputBg(dark: Boolean) = if (dark) Color(0xFF2A2A2D) else Color(0xFFF1F1F2)
private fun divider(dark: Boolean) = if (dark) Color(0xFF2C2C2E) else DividerColor
private fun momoBrush() = Brush.linearGradient(listOf(Color(0xFF5B6CFF), Color(0xFF7C57F4)))
private fun userBrush() = Brush.linearGradient(listOf(Color(0xFF47B957), Color(0xFF2D8C3E)))
private fun cloneBrush(seed: String): Brush {
    val colors = listOf(
        listOf(Color(0xFFFF8B5F), Color(0xFFFF625C)),
        listOf(Color(0xFF36D675), Color(0xFF20B65D)),
        listOf(Color(0xFFB86AF6), Color(0xFF8B55F6)),
    )
    return Brush.linearGradient(colors[kotlin.math.abs(seed.hashCode()) % colors.size])
}

private fun statusColor(session: Session): Color = when {
    session.jobFailed == true || session.agentStatus.contains("fail", true) -> Danger
    session.agentStatus.contains("run", true) || session.agentStatus.contains("work", true) -> Success
    session.jobAccomplished == true -> Success
    else -> Color(0xFFB5B7BD)
}

private fun cloneIndex(name: String): String {
    val match = Regex("""#\s*(\d+)""").find(name)
    return match?.groupValues?.getOrNull(1) ?: "1"
}

private fun demoSessions() = listOf(
    Session(sessionId = "demo-main", name = "我的主小莫", description = "你好呀，我是小莫...", agentStatus = "idle", lastActive = "10:24"),
    Session(sessionId = "demo-1", name = "分身小莫 #1 - 查项目列表", description = "找到 13 个项目，正在整理...", agentStatus = "running", lastActive = "10:24"),
    Session(sessionId = "demo-2", name = "分身小莫 #2 - 汇总今日 Issue", description = "今日新增 3 个 Issue", agentStatus = "running", lastActive = "10:25"),
    Session(sessionId = "demo-3", name = "分身小莫 #3 - 写测试用例", description = "API 错误：timeout", agentStatus = "failed", lastActive = "10:18", jobFailed = true),
)
