package com.mobius.momo.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
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
import com.mobius.momo.viewmodel.AttachmentStatus
import com.mobius.momo.viewmodel.ComposerInputMode
import com.mobius.momo.viewmodel.LoginStep
import com.mobius.momo.viewmodel.MomoAppViewModel
import com.mobius.momo.viewmodel.ThemeMode
import com.mobius.momo.viewmodel.ThemePalette
import com.mobius.momo.viewmodel.UiState
import com.mobius.momo.viewmodel.canSendComposerMessage
import androidx.compose.foundation.rememberScrollState

@Composable
expect fun momoLogoPainter(): Painter

@Immutable
data class MomoTheme(
    val themeMode: ThemeMode,
    val palette: ThemePalette,
    val dark: Boolean,
    val accentPrimary: Color,
    val accentSecondary: Color,
    val bgPrimary: Color,
    val bgSecondary: Color,
    val textPrimary: Color,
    val textMuted: Color,
    val borderDefault: Color,
    val inputBg: Color,
    val bubbleBg: Color,
    val danger: Color,
    val success: Color,
)

@Composable
fun MomoApp(viewModel: MomoAppViewModel = remember { MomoAppViewModel() }) {
    val state by viewModel.state.collectAsState()
    val systemDark = isSystemInDarkTheme()
    val dark = when (state.themeMode) {
        ThemeMode.System -> systemDark
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val theme = momoTheme(state.themeMode, state.themePalette, dark)

    MaterialTheme(
        colorScheme = if (dark) darkColorScheme(primary = theme.accentPrimary, background = theme.bgPrimary, surface = theme.bgSecondary)
        else lightColorScheme(primary = theme.accentPrimary, background = theme.bgPrimary, surface = theme.bgSecondary),
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = theme.bgPrimary,
        ) {
            Box(Modifier.fillMaxSize()) {
                when (state.screen) {
                    AppScreen.Login -> LoginScreen(state, theme, viewModel)
                    AppScreen.Home -> HomeScreen(state, theme, viewModel)
                    AppScreen.Clones -> CloneListScreen(state, theme, viewModel)
                    AppScreen.Settings -> SettingsScreen(state, theme, viewModel)
                }
                state.toast?.let { ToastBubble(it, theme) }
                if (state.cloneSheetOpen) CloneSheet(state, theme, viewModel)
            }
        }
    }
}

@Composable
private fun LoginScreen(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    val bg = if (theme.dark) theme.bgPrimary else theme.bgSecondary
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(bg)
            .statusBarsPadding()
            .padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(88.dp))
        MomoLogo(80.dp)
        Spacer(Modifier.height(32.dp))
        Text("小莫助理", color = theme.textPrimary, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text("登录后与你的 AI 项目助理对话", color = theme.textMuted, fontSize = 15.sp)
        Spacer(Modifier.height(72.dp))
        if (state.loginStep == LoginStep.Username) {
            MomoInput(
                value = state.username,
                placeholder = "请输入用户名",
                theme = theme,
                onChange = vm::setUsername,
            )
            Spacer(Modifier.height(22.dp))
            PrimaryButton(if (state.passwordRequired) "下一步" else "登 录", state.loading, theme, vm::nextLoginStep)
        } else {
            MomoInput(
                value = state.password,
                placeholder = "请输入密码",
                theme = theme,
                password = true,
                onChange = vm::setPassword,
            )
            Spacer(Modifier.height(22.dp))
            PrimaryButton("登 录", state.loading, theme, vm::login)
            TextButton(onClick = vm::backToUsername) {
                Text("换一个账号", color = theme.accentPrimary, fontSize = 14.sp)
            }
        }
        Spacer(Modifier.height(28.dp))
        Text("忘记密码？请联系管理员", color = theme.textMuted, fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        Text("更多登录方式 ›", color = theme.accentPrimary, fontSize = 15.sp, modifier = Modifier.padding(bottom = 40.dp))
    }
}

@Composable
private fun HomeScreen(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size, state.typing) {
        val extraTypingRow = if (state.typing) 1 else 0
        val lastIndex = state.messages.size + extraTypingRow
        if (lastIndex > 0) listState.scrollToItem(lastIndex)
    }

    Column(Modifier.fillMaxSize().background(theme.bgPrimary).statusBarsPadding()) {
        TopBar(
            title = state.activeSessionTitle.ifBlank { "我的主小莫" },
            theme = theme,
            left = null,
            right = "☰",
            onRight = vm::toggleMenu,
        )
        Box(Modifier.weight(1f)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { Spacer(Modifier.height(4.dp)) }
                items(state.messages) { message -> MessageRow(message, theme, vm::replayAssistantMessage) }
                if (state.typing) {
                    item {
                        Row(verticalAlignment = Alignment.Top) {
                            MomoLogo(36.dp)
                            Spacer(Modifier.width(8.dp))
                            TypingBubble(theme)
                        }
                    }
                }
                item { Spacer(Modifier.height(12.dp)) }
            }
            MenuPanel(state.menuOpen, theme, vm)
        }
        ChatInputBar(state, theme, vm)
    }
}

@Composable
private fun CloneListScreen(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    Column(Modifier.fillMaxSize().background(theme.bgPrimary).statusBarsPadding()) {
        TopBar("分身列表", theme, left = "‹", onLeft = { vm.navigate(AppScreen.Home) })
        LazyColumn(Modifier.weight(1f).background(theme.bgSecondary)) {
            if (state.clones.isEmpty()) {
                item {
                    Box(Modifier.fillMaxWidth().height(160.dp).background(theme.bgSecondary), contentAlignment = Alignment.Center) {
                        Text("暂无小莫会话", color = theme.textMuted, fontSize = 15.sp)
                    }
                }
            } else {
                items(state.clones) { session ->
                    CloneRow(session, theme) { vm.openSession(session) }
                    Divider(color = theme.borderDefault, thickness = 0.6.dp)
                }
            }
        }
        Box(
            Modifier.fillMaxWidth().height(64.dp).background(theme.bgSecondary).clickable { vm.openCloneSheet() },
            contentAlignment = Alignment.Center,
        ) {
            Text("+  开分身", color = theme.accentPrimary, fontSize = 17.sp)
        }
    }
}

@Composable
private fun SettingsScreen(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    Column(Modifier.fillMaxSize().background(theme.bgPrimary).statusBarsPadding()) {
        TopBar("设置", theme, left = "‹", onLeft = { vm.navigate(AppScreen.Home) })
        Spacer(Modifier.height(14.dp))
        SettingSwitch("暗色模式", state.themeMode == ThemeMode.Dark || (state.themeMode == ThemeMode.System && theme.dark), theme) {
            vm.setThemeMode(if (theme.dark) ThemeMode.Light else ThemeMode.Dark)
        }
        SettingSwitch("消息推送", state.pushEnabled, theme, vm::togglePush)
        SettingSwitch("自动播报", state.ttsEnabled, theme, vm::toggleTts)
        Spacer(Modifier.height(14.dp))
        SettingSectionTitle("主题风格", theme)
        ThemePaletteSelector(state.themePalette, theme, vm::setThemePalette)
        Spacer(Modifier.height(14.dp))
        SettingRow("账号", state.user?.displayName ?: state.user?.id.orEmpty(), theme)
        SettingRow("小莫预设", "默认小莫", theme)
        SettingRow("关于", "v0.1.0", theme)
        Spacer(Modifier.height(14.dp))
        Box(
            Modifier.fillMaxWidth().height(56.dp).background(theme.bgSecondary).clickable { vm.logout() }.padding(horizontal = 16.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text("退出登录", color = theme.danger, fontSize = 17.sp)
        }
        Spacer(Modifier.weight(1f))
        Text(
            "小莫助理 · v0.1.0",
            color = theme.textMuted,
            fontSize = 13.sp,
            modifier = Modifier.fillMaxWidth().padding(bottom = 42.dp),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun TopBar(
    title: String,
    theme: MomoTheme,
    left: String? = null,
    right: String? = null,
    onLeft: () -> Unit = {},
    onRight: () -> Unit = {},
) {
    Box(
        Modifier.fillMaxWidth().height(56.dp).background(theme.bgSecondary).border(0.5.dp, theme.borderDefault),
    ) {
        if (left != null) {
            Text(
                left,
                color = theme.textPrimary,
                fontSize = 28.sp,
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 24.dp).clickable { onLeft() },
            )
        }
        Text(title, color = theme.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.Center))
        if (right != null) {
            Text(
                right,
                color = theme.textPrimary,
                fontSize = 26.sp,
                modifier = Modifier.align(Alignment.CenterEnd).padding(end = 24.dp).clickable { onRight() },
            )
        }
    }
}

@Composable
private fun MessageRow(message: ChatMessage, theme: MomoTheme, onReplay: (ChatMessage) -> Unit) {
    val isUser = message.author == MessageAuthor.User
    var showReplay by remember(message.id) { mutableStateOf(false) }
    val onSurfaceVariant = MaterialTheme.colorScheme.onSurfaceVariant
    val primary = MaterialTheme.colorScheme.primary
    val replayInteraction = remember { MutableInteractionSource() }
    val replayPressed by replayInteraction.collectIsPressedAsState()
    val replayColor by animateColorAsState(
        targetValue = if (replayPressed) primary else onSurfaceVariant,
        animationSpec = tween(durationMillis = 150),
        label = "replayColor",
    )
    val replayScale by animateFloatAsState(
        targetValue = if (replayPressed) 0.92f else 1f,
        animationSpec = tween(durationMillis = 150),
        label = "replayScale",
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!isUser) {
            MomoLogo(36.dp)
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (isUser) Alignment.End else Alignment.Start, modifier = Modifier.fillMaxWidth(0.84f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
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
                        .background(if (isUser) theme.accentPrimary else theme.bubbleBg)
                        .pointerInput(message.id) {
                            detectTapGestures(
                                onLongPress = { showReplay = !showReplay },
                            )
                        }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                ) {
                    Text(
                        message.text,
                        color = if (isUser) Color.White else theme.textPrimary,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                    )
                }
                if (showReplay && message.author == MessageAuthor.Momo && message.text.isNotBlank()) {
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier
                            .size(24.dp)
                            .scale(replayScale)
                            .clickable(
                                interactionSource = replayInteraction,
                                indication = null,
                            ) { onReplay(message); showReplay = false },
                        contentAlignment = Alignment.Center,
                    ) {
                        SpeakerIcon(replayColor)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(message.time, color = theme.textMuted, fontSize = 11.sp)
        }
        if (isUser) {
            Spacer(Modifier.width(8.dp))
            AvatarSquare("Z", 36.dp, userBrush())
        }
    }
}

@Composable
private fun TypingBubble(theme: MomoTheme) {
    Row(
        Modifier.clip(RoundedCornerShape(4.dp, 12.dp, 12.dp, 12.dp)).background(theme.bubbleBg).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(3) { Box(Modifier.size(6.dp).clip(CircleShape).background(Color(0xFFD2D2D4))) }
    }
}

@Composable
private fun ChatInputBar(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    val canSend = state.canSendComposerMessage()
    Column(
        modifier = Modifier.fillMaxWidth().background(theme.bgSecondary).imePadding().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.attachments.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.attachments.forEach { attachment ->
                    Row(
                        modifier = Modifier
                            .width(186.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(theme.bubbleBg)
                            .border(
                                1.dp,
                                if (attachment.status == AttachmentStatus.Error) theme.danger else theme.borderDefault,
                                RoundedCornerShape(14.dp),
                            )
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            Modifier.size(36.dp).clip(RoundedCornerShape(9.dp)).background(theme.inputBg),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                attachment.name.substringAfterLast('.', "文件").take(4).uppercase(),
                                color = theme.textMuted,
                                fontSize = 9.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        Column(Modifier.weight(1f)) {
                            Text(attachment.name, color = theme.textPrimary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                when (attachment.status) {
                                    AttachmentStatus.Uploading -> "上传中..."
                                    AttachmentStatus.Done -> formatAttachmentSize(attachment.size)
                                    AttachmentStatus.Error -> attachment.error.ifBlank { "上传失败" }
                                },
                                color = if (attachment.status == AttachmentStatus.Error) theme.danger else theme.textMuted,
                                fontSize = 10.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            "×",
                            color = theme.textMuted,
                            fontSize = 20.sp,
                            modifier = Modifier.clickable { vm.removeAttachment(attachment.id) }.padding(3.dp),
                        )
                    }
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            IconButtonCircle(theme, size = 34.dp, onClick = vm::pickAttachments) {
                PlusIcon(theme.textPrimary)
            }
            if (state.composerInputMode == ComposerInputMode.Text) {
                BasicTextField(
                    value = state.input,
                    onValueChange = vm::setInput,
                    singleLine = true,
                    textStyle = TextStyle(color = theme.textPrimary, fontSize = 15.sp),
                    modifier = Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(22.dp)).background(theme.inputBg).border(1.dp, theme.borderDefault, RoundedCornerShape(22.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
                    decorationBox = { inner ->
                        if (state.input.isBlank()) Text("说点什么...", color = theme.textMuted, fontSize = 15.sp)
                        inner()
                    },
                )
            } else {
                VoiceHoldButton(state, theme, vm, Modifier.weight(1f))
            }
            Box(
                Modifier.size(44.dp).clip(CircleShape).clickable(
                    enabled = !state.voiceRecording && !state.voiceTranscribing,
                    onClick = vm::toggleComposerMode,
                ),
                contentAlignment = Alignment.Center,
            ) {
                if (state.composerInputMode == ComposerInputMode.Text) MicrophoneIcon(theme.textPrimary)
                else KeyboardIcon(theme.textPrimary)
            }
            if (state.composerInputMode == ComposerInputMode.Text) {
                SendButton(canSend = canSend, sending = state.sendingMessage, theme = theme, onClick = vm::sendHomeMessage)
            }
        }
    }
}

@Composable
private fun VoiceHoldButton(
    state: UiState,
    theme: MomoTheme,
    vm: MomoAppViewModel,
    modifier: Modifier = Modifier,
) {
    var dragY by remember { mutableStateOf(0f) }
    val background = when {
        state.voiceCanceling -> theme.danger
        state.voiceRecording -> theme.accentPrimary
        else -> theme.inputBg
    }
    Box(
        modifier = modifier
            .height(44.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(background)
            .border(1.dp, if (state.voiceRecording) Color.Transparent else theme.borderDefault, RoundedCornerShape(22.dp))
            .pointerInput(state.voiceTranscribing) {
                if (state.voiceTranscribing) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    dragY = 0f
                    vm.beginVoiceInput()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        dragY += change.positionChange().y
                        vm.updateVoiceDrag(dragY)
                        change.consume()
                        if (!change.pressed) {
                            vm.finishVoiceInput()
                            break
                        }
                    }
                    dragY = 0f
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (state.voiceRecording) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(
                    when {
                        state.voiceCanceling -> "松手取消"
                        state.voiceTranscribing -> "正在识别..."
                        state.voiceTranscript.isNotBlank() -> state.voiceTranscript
                        else -> "正在听..."
                    },
                    color = Color.White,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Spacer(Modifier.height(3.dp))
                VoiceVolumeMeter(state.voiceVolumeLevel)
            }
        } else if (state.voiceTranscribing) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(18.dp), color = theme.accentPrimary, strokeWidth = 2.dp)
                Text("正在识别...", color = theme.textMuted, fontSize = 14.sp)
            }
        } else {
            Text("按住说话", color = theme.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private fun formatAttachmentSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> {
        val tenths = bytes * 10 / (1024 * 1024)
        "${tenths / 10}.${tenths % 10} MB"
    }
}

@Composable
private fun VoiceVolumeMeter(level: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
        repeat(5) { index ->
            val active = index < level.coerceIn(0, 5)
            Box(
                Modifier
                    .width(5.dp)
                    .height((5 + index * 2).dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(if (active) Color.White else Color.White.copy(alpha = 0.36f)),
            )
        }
    }
}

@Composable
private fun BoxScope.MenuPanel(open: Boolean, theme: MomoTheme, vm: MomoAppViewModel) {
    AnimatedVisibility(open, modifier = Modifier.align(Alignment.TopEnd)) {
        Column(
            Modifier.padding(12.dp).width(184.dp).clip(RoundedCornerShape(12.dp)).background(theme.bgSecondary).border(0.5.dp, theme.borderDefault, RoundedCornerShape(12.dp)),
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
private fun CloneRow(session: Session, theme: MomoTheme, onClick: () -> Unit) {
    val roleMain = session.assistantRole == "main" || session.name == "我的主小莫" || session.name.contains("主小莫")
    Row(
        Modifier.fillMaxWidth().height(76.dp).background(theme.bgSecondary).clickable { onClick() }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (roleMain) MomoLogo(36.dp) else AvatarSquare(cloneIndex(session.name), 36.dp, cloneBrush(session.name))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(session.name.ifBlank { "分身小莫" }, color = theme.textPrimary, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (roleMain) {
                    Spacer(Modifier.width(8.dp))
                    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(theme.accentPrimary).padding(horizontal = 7.dp, vertical = 2.dp)) {
                        Text("主体", color = Color.White, fontSize = 12.sp)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(session.description.ifBlank { "你好呀，我是小莫..." }, color = theme.textMuted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(session.lastActive.takeIf { it.contains(":") }?.takeLast(8)?.take(5) ?: "10:24", color = theme.textMuted, fontSize = 12.sp)
            Spacer(Modifier.height(10.dp))
            Box(Modifier.size(8.dp).clip(CircleShape).background(statusColor(session, theme)))
        }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, theme: MomoTheme, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(64.dp).background(theme.bgSecondary).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = theme.textPrimary, fontSize = 17.sp, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = { onClick() })
    }
    Divider(color = theme.borderDefault, thickness = 0.6.dp)
}

@Composable
private fun SettingRow(label: String, value: String, theme: MomoTheme) {
    Row(
        Modifier.fillMaxWidth().height(64.dp).background(theme.bgSecondary).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = theme.textPrimary, fontSize = 17.sp, modifier = Modifier.weight(1f))
        if (value.isNotBlank()) Text(value, color = theme.textMuted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.width(8.dp))
        Text("›", color = theme.textMuted, fontSize = 22.sp)
    }
    Divider(color = theme.borderDefault, thickness = 0.6.dp)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloneSheet(state: UiState, theme: MomoTheme, vm: MomoAppViewModel) {
    ModalBottomSheet(onDismissRequest = vm::closeCloneSheet, containerColor = theme.bgSecondary) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("开一个分身小莫", color = theme.textPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("分身会在当前小莫任务单下创建独立 Session。", color = theme.textMuted, fontSize = 13.sp)
            MomoInput(state.cloneTitle, "分身名称", theme, onChange = vm::setCloneTitle)
            MomoInput(state.cloneDescription, "任务描述", theme, minHeight = 92.dp, onChange = vm::setCloneDescription)
            Text("选择模型", color = theme.textMuted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.cloneModelOptions, key = { it.key }) { option ->
                    val selected = state.cloneModel == option.key
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (selected) theme.accentPrimary.copy(alpha = 0.12f) else theme.inputBg)
                            .border(1.dp, if (selected) theme.accentPrimary else theme.borderDefault, RoundedCornerShape(12.dp))
                            .clickable { vm.setCloneModel(option.key) }
                            .padding(horizontal = 14.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                option.label.ifBlank { option.title.ifBlank { option.key } },
                                color = theme.textPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (option.sub.isNotBlank()) {
                                Spacer(Modifier.height(3.dp))
                                Text(option.sub, color = theme.textMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (selected) Text("✓", color = theme.accentPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            PrimaryButton("+ 创建并启动", state.loading, theme, vm::createClone)
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun MomoInput(
    value: String,
    placeholder: String,
    theme: MomoTheme,
    password: Boolean = false,
    minHeight: androidx.compose.ui.unit.Dp = 48.dp,
    onChange: (String) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = TextStyle(color = theme.textPrimary, fontSize = 17.sp),
        visualTransformation = if (password) PasswordVisualTransformation('•') else VisualTransformation.None,
        modifier = Modifier.fillMaxWidth().height(minHeight).clip(RoundedCornerShape(8.dp)).background(theme.inputBg).border(1.dp, if (focused) theme.accentPrimary else theme.borderDefault, RoundedCornerShape(8.dp)).padding(horizontal = 16.dp, vertical = 13.dp),
        decorationBox = { inner ->
            Box {
                if (value.isBlank()) Text(placeholder, color = theme.textMuted, fontSize = 16.sp)
                inner()
            }
        },
    )
}

@Composable
private fun PrimaryButton(label: String, loading: Boolean, theme: MomoTheme, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = !loading,
        modifier = Modifier.fillMaxWidth().height(48.dp),
        shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = theme.accentPrimary, contentColor = Color.White),
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
private fun MomoLogo(size: androidx.compose.ui.unit.Dp) {
    val transition = rememberInfiniteTransition(label = "momoOrb")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = androidx.compose.animation.core.tween(11_000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "momoOrbRotation",
    )
    val pulse by transition.animateFloat(
        initialValue = 0.94f,
        targetValue = 1.06f,
        animationSpec = infiniteRepeatable(
            animation = androidx.compose.animation.core.tween(3_200),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "momoOrbPulse",
    )
    Canvas(Modifier.size(size).scale(pulse)) {
        val radius = this.size.minDimension / 2f
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color.White,
                    Color(0xFF7DD3FC),
                    Color(0xFF818CF8),
                    Color(0xFF2DD4BF),
                    Color(0xFFFB7185),
                ),
                center = Offset(this.size.width * 0.35f, this.size.height * 0.29f),
                radius = radius * 1.45f,
            ),
            radius = radius * 0.96f,
            center = center,
        )
        rotate(rotation, pivot = center) {
            drawOval(
                color = Color(0xCCE0F2FE),
                topLeft = Offset(this.size.width * 0.09f, this.size.height * 0.17f),
                size = Size(this.size.width * 0.82f, this.size.height * 0.66f),
                style = Stroke(width = (this.size.minDimension * 0.025f).coerceAtLeast(1f)),
            )
        }
        rotate(-rotation * 1.2f, pivot = center) {
            drawOval(
                color = Color(0xBFFDba74),
                topLeft = Offset(this.size.width * 0.27f, this.size.height * 0.31f),
                size = Size(this.size.width * 0.46f, this.size.height * 0.38f),
                style = Stroke(width = (this.size.minDimension * 0.022f).coerceAtLeast(1f)),
            )
        }
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color.White, Color(0xFFA5F3FC), Color(0x3356BFF8)),
                center = Offset(this.size.width * 0.42f, this.size.height * 0.40f),
                radius = radius * 0.34f,
            ),
            radius = radius * 0.19f,
            center = Offset(this.size.width * 0.42f, this.size.height * 0.40f),
        )
        val particlePoints = listOf(
            0.50f to 0.07f, 0.69f to 0.13f, 0.84f to 0.31f, 0.86f to 0.57f,
            0.69f to 0.79f, 0.43f to 0.87f, 0.20f to 0.72f, 0.10f to 0.44f,
            0.22f to 0.19f, 0.61f to 0.50f,
        )
        particlePoints.forEachIndexed { index, (x, y) ->
            drawCircle(
                color = when (index % 4) {
                    0 -> Color(0xFFE0F2FE)
                    1 -> Color(0xFFA7F3D0)
                    2 -> Color(0xFFFDE68A)
                    else -> Color(0xFFFBCFE8)
                },
                radius = (this.size.minDimension * if (index % 3 == 0) 0.028f else 0.021f).coerceAtLeast(1.2f),
                center = Offset(this.size.width * x, this.size.height * y),
            )
        }
    }
}

@Composable
private fun IconButtonCircle(
    theme: MomoTheme,
    size: androidx.compose.ui.unit.Dp = 44.dp,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        Modifier.size(size).clip(CircleShape).background(theme.inputBg).border(1.dp, theme.borderDefault, CircleShape).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun SendButton(canSend: Boolean, sending: Boolean, theme: MomoTheme, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val bg = if (canSend || sending) theme.accentPrimary else theme.textMuted.copy(alpha = 0.35f)
    Box(
        Modifier
            .size(44.dp)
            .scale(if (pressed && canSend && !sending) 0.97f else 1f)
            .clip(CircleShape)
            .background(bg)
            .clickable(
                enabled = canSend && !sending,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (sending) {
            CircularProgressIndicator(
                modifier = Modifier.size(21.dp),
                color = Color.White,
                strokeWidth = 2.dp,
            )
        } else {
            SendIcon(if (canSend) Color.White else Color.White.copy(alpha = 0.72f))
        }
    }
}

@Composable
private fun ThemePaletteSelector(selected: ThemePalette, theme: MomoTheme, onSelect: (ThemePalette) -> Unit) {
    Column(Modifier.fillMaxWidth().background(theme.bgSecondary)) {
        ThemePalette.entries.forEach { palette ->
            val colors = paletteSwatches(palette, theme.dark)
            Row(
                Modifier.fillMaxWidth().height(56.dp).clickable { onSelect(palette) }.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.width(52.dp)) {
                    Box(Modifier.size(18.dp).clip(CircleShape).background(colors.first))
                    Box(Modifier.size(18.dp).clip(CircleShape).background(colors.second))
                }
                Text(palette.label, color = theme.textPrimary, fontSize = 16.sp, modifier = Modifier.weight(1f))
                if (selected == palette) {
                    CheckIcon(theme.accentPrimary)
                }
            }
            Divider(color = theme.borderDefault, thickness = 0.6.dp)
        }
    }
}

@Composable
private fun SettingSectionTitle(label: String, theme: MomoTheme) {
    Text(
        label,
        color = theme.textMuted,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun ToastBubble(text: String, theme: MomoTheme) {
    Box(Modifier.fillMaxSize().padding(top = 72.dp), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.clip(RoundedCornerShape(22.dp)).background(if (theme.dark) Color(0xEE2A2A2D) else Color(0xEE202124)).padding(horizontal = 16.dp, vertical = 10.dp)) {
            Text(text, color = Color.White, fontSize = 13.sp)
        }
    }
}

@Composable
private fun PlusIcon(color: Color) {
    Canvas(Modifier.size(24.dp)) {
        drawLine(color, Offset(size.width * 0.16f, size.height * 0.50f), Offset(size.width * 0.84f, size.height * 0.50f), strokeWidth = 2.2f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.50f, size.height * 0.16f), Offset(size.width * 0.50f, size.height * 0.84f), strokeWidth = 2.2f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

@Composable
private fun KeyboardIcon(color: Color) {
    Canvas(Modifier.size(24.dp)) {
        repeat(3) { row ->
            repeat(3) { column ->
                drawRoundRect(
                    color = color,
                    topLeft = Offset(size.width * (0.18f + column * 0.26f), size.height * (0.18f + row * 0.26f)),
                    size = Size(size.width * 0.12f, size.height * 0.12f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(1.2f, 1.2f),
                )
            }
        }
    }
}

@Composable
private fun MicrophoneIcon(color: Color) {
    Canvas(Modifier.size(24.dp)) {
        val stroke = Stroke(width = 1.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawRoundRect(color, topLeft = Offset(size.width * 0.34f, size.height * 0.13f), size = Size(size.width * 0.32f, size.height * 0.46f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(7f, 7f), style = stroke)
        drawArc(color, startAngle = 35f, sweepAngle = 110f, useCenter = false, topLeft = Offset(size.width * 0.22f, size.height * 0.35f), size = Size(size.width * 0.56f, size.height * 0.44f), style = stroke)
        drawLine(color, Offset(size.width * 0.50f, size.height * 0.79f), Offset(size.width * 0.50f, size.height * 0.88f), strokeWidth = 1.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.36f, size.height * 0.88f), Offset(size.width * 0.64f, size.height * 0.88f), strokeWidth = 1.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

@Composable
private fun SendIcon(color: Color) {
    Canvas(Modifier.size(24.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.18f, size.height * 0.20f)
            lineTo(size.width * 0.84f, size.height * 0.50f)
            lineTo(size.width * 0.18f, size.height * 0.80f)
            lineTo(size.width * 0.30f, size.height * 0.55f)
            lineTo(size.width * 0.56f, size.height * 0.50f)
            lineTo(size.width * 0.30f, size.height * 0.45f)
            close()
        }
        drawPath(path, color)
    }
}

@Composable
private fun SpeakerIcon(color: Color) {
    Canvas(Modifier.size(18.dp)) {
        val stroke = Stroke(width = 1.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        val body = Path().apply {
            moveTo(size.width * 0.12f, size.height * 0.40f)
            lineTo(size.width * 0.30f, size.height * 0.40f)
            lineTo(size.width * 0.52f, size.height * 0.24f)
            lineTo(size.width * 0.52f, size.height * 0.76f)
            lineTo(size.width * 0.30f, size.height * 0.60f)
            lineTo(size.width * 0.12f, size.height * 0.60f)
            close()
        }
        drawPath(body, color)
        drawArc(color, startAngle = -35f, sweepAngle = 70f, useCenter = false, topLeft = Offset(size.width * 0.48f, size.height * 0.32f), size = Size(size.width * 0.30f, size.height * 0.36f), style = stroke)
    }
}

@Composable
private fun CheckIcon(color: Color) {
    Canvas(Modifier.size(22.dp)) {
        drawLine(color, Offset(size.width * 0.20f, size.height * 0.54f), Offset(size.width * 0.42f, size.height * 0.74f), strokeWidth = 2.4f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(color, Offset(size.width * 0.42f, size.height * 0.74f), Offset(size.width * 0.82f, size.height * 0.28f), strokeWidth = 2.4f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

private fun momoTheme(themeMode: ThemeMode, palette: ThemePalette, dark: Boolean): MomoTheme {
    val (accentPrimary, accentSecondary) = paletteSwatches(palette, dark)
    return MomoTheme(
        themeMode = themeMode,
        palette = palette,
        dark = dark,
        accentPrimary = accentPrimary,
        accentSecondary = accentSecondary,
        bgPrimary = if (dark) Color(0xFF111111) else Color(0xFFF3F3F4),
        bgSecondary = if (dark) Color(0xFF1D1D1F) else Color.White,
        textPrimary = if (dark) Color(0xFFF5F5F7) else Color(0xFF111111),
        textMuted = if (dark) Color(0xFFA4A8B1) else Color(0xFF6B7280),
        borderDefault = if (dark) Color(0xFF2C2C2E) else Color(0xFFE7E7E8),
        inputBg = if (dark) Color(0xFF2A2A2D) else Color(0xFFF1F1F2),
        bubbleBg = if (dark) Color(0xFF2A2A2D) else Color.White,
        danger = Color(0xFFFF5B5F),
        success = Color(0xFF54D17A),
    )
}

private fun paletteSwatches(palette: ThemePalette, dark: Boolean): Pair<Color, Color> = when (palette) {
    ThemePalette.Default -> Color(0xFF5B6CFF) to Color(0xFF7C57F4)
    ThemePalette.Aurora -> if (dark) Color(0xFF38BDF8) to Color(0xFF2DD4BF) else Color(0xFFC4B5FD) to Color(0xFFF0ABFC)
    ThemePalette.Mint -> if (dark) Color(0xFF22D3EE) to Color(0xFF2DD4BF) else Color(0xFF86EFAC) to Color(0xFF2DD4BF)
    ThemePalette.Coral -> Color(0xFFFB7185) to Color(0xFFF0ABFC)
    ThemePalette.Gold -> if (dark) Color(0xFFF59E0B) to Color(0xFFDC2626) else Color(0xFF2563EB) to Color(0xFF0D9488)
}

private fun userBrush() = Brush.linearGradient(listOf(Color(0xFF47B957), Color(0xFF2D8C3E)))
private fun cloneBrush(seed: String): Brush {
    val colors = listOf(
        listOf(Color(0xFFFF8B5F), Color(0xFFFF625C)),
        listOf(Color(0xFF36D675), Color(0xFF20B65D)),
        listOf(Color(0xFFB86AF6), Color(0xFF8B55F6)),
    )
    return Brush.linearGradient(colors[kotlin.math.abs(seed.hashCode()) % colors.size])
}

private fun statusColor(session: Session, theme: MomoTheme): Color = when {
    session.jobFailed == true || session.agentStatus.contains("fail", true) -> theme.danger
    session.agentStatus.contains("run", true) || session.agentStatus.contains("work", true) -> theme.success
    session.jobAccomplished == true -> theme.success
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
