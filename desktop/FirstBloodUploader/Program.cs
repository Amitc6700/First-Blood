using System.Diagnostics;
using System.Drawing;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using Velopack;
using Velopack.Sources;

namespace FirstBloodUploader;

internal static class Program {
    [STAThread] static void Main() { VelopackApp.Build().Run(); ApplicationConfiguration.Initialize(); Application.Run(new MainForm()); }
}

sealed class UiSettings {
    public bool StartWithWindows { get; set; }
    public bool MinimizeToTray { get; set; } = true;
    public bool StartMinimized { get; set; } = true;
}

sealed class MainForm : Form {
    const string UpdateRepository="https://github.com/Amitc6700/First-Blood";
    readonly string appDir = AppContext.BaseDirectory;
    readonly string configDir;
    readonly string configFile;
    readonly string uiFile;
    readonly string logFile;
    readonly ListView activity = new();
    readonly Label state = new(), uploaded = new(), duplicates = new(), skipped = new(), failed = new();
    readonly Panel statusDot = new();
    readonly CheckBox startup = new(), tray = new();
    readonly NotifyIcon notify = new();
    UiSettings settings = new();
    Process? worker;
    int uploadedCount, duplicateCount, skippedCount, failedCount;
    bool exiting;

    public MainForm() {
        configDir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FirstBloodUploader");Directory.CreateDirectory(configDir);MigrateLegacyFiles();
        configFile=Path.Combine(configDir,"recorder.config.json");uiFile=Path.Combine(configDir,"uploader-ui.json"); logFile=Path.Combine(configDir,"uploader.log"); settings=LoadSettings();
        Text="First Blood Uploader"; Icon=LoadAppIcon(); ClientSize=new Size(760,610); MinimumSize=new Size(680,540); BackColor=Color.FromArgb(13,18,22); ForeColor=Color.Gainsboro; Font=new Font("Segoe UI",10); StartPosition=FormStartPosition.CenterScreen;
        BuildUi(); LoadHistory(); BuildTray(); ApplyStartup(); Shown += (_,_) => { StartWorker(); if(NeedsRegistration())BeginInvoke(OpenSettings);else if(settings.StartMinimized && settings.StartWithWindows) HideToTray(); };
        FormClosing += (_,e) => { if(!exiting && settings.MinimizeToTray){e.Cancel=true;HideToTray();} else StopWorker(); };
    }

    void BuildUi() {
        var header=new PictureBox { Image=LoadBanner(),Dock=DockStyle.Top,Height=126,SizeMode=PictureBoxSizeMode.Zoom,BackColor=Color.FromArgb(8,12,15),Padding=new Padding(8) }; Controls.Add(header);
        var right=new Panel { Dock=DockStyle.Right,Width=235,Padding=new Padding(18),BackColor=Color.FromArgb(18,24,29) }; Controls.Add(right);
        statusDot.SetBounds(18,23,12,12);statusDot.BackColor=Color.Gray;var dotPath=new System.Drawing.Drawing2D.GraphicsPath();dotPath.AddEllipse(0,0,12,12);statusDot.Region=new Region(dotPath);right.Controls.Add(statusDot);
        state.Text="Starting…"; state.Font=new Font("Segoe UI",11,FontStyle.Bold); state.SetBounds(42,17,175,38); right.Controls.Add(state);
        var stats=new FlowLayoutPanel { Left=18,Top=65,Width=195,Height=135,FlowDirection=FlowDirection.TopDown,WrapContents=false }; right.Controls.Add(stats);
        foreach(var (label,name) in new[]{(uploaded,"Success: 0"),(duplicates,"Duplicate: 0"),(skipped,"Cannot complete: 0"),(failed,"Retry errors: 0")}) { label.Text=name; label.AutoSize=true; label.Margin=new Padding(0,5,0,5); stats.Controls.Add(label); }
        startup.Text="Start with Windows"; startup.Checked=settings.StartWithWindows; startup.AutoSize=true; startup.Top=225; startup.Left=18; startup.CheckedChanged+=(_,_)=>{settings.StartWithWindows=startup.Checked;ApplyStartup();SaveSettings();}; right.Controls.Add(startup);
        tray.Text="Minimize to tray"; tray.Checked=settings.MinimizeToTray; tray.AutoSize=true; tray.Top=260; tray.Left=18; tray.CheckedChanged+=(_,_)=>{settings.MinimizeToTray=tray.Checked;SaveSettings();}; right.Controls.Add(tray);
        var settingsButton=Button("Settings",305); settingsButton.Click+=(_,_)=>OpenSettings(); right.Controls.Add(settingsButton);
        var logsButton=Button("Show logs",345); logsButton.Click+=(_,_)=>ShowLogs(); right.Controls.Add(logsButton);
        var siteButton=Button("Open website",385); siteButton.Click+=(_,_)=>Process.Start(new ProcessStartInfo("https://hollowpoints.gg/first-blood"){UseShellExecute=true}); right.Controls.Add(siteButton);
        var updateButton=Button("Check for updates",425);updateButton.Click+=async(_,_)=>await CheckForUpdates(updateButton);right.Controls.Add(updateButton);
        var exitButton=Button("Exit",465); exitButton.Click+=(_,_)=>ExitApp(); right.Controls.Add(exitButton);
        activity.Dock=DockStyle.Fill; activity.View=View.Details; activity.FullRowSelect=true; activity.BackColor=Color.FromArgb(17,22,27); activity.ForeColor=Color.Gainsboro; activity.BorderStyle=BorderStyle.FixedSingle; activity.Columns.Add("Timestamp",130); activity.Columns.Add("Match ID",260); activity.Columns.Add("Result",125); Controls.Add(activity); activity.BringToFront();
    }

    Button Button(string text,int top)=>new(){Text=text,Left=18,Top=top,Width=198,Height=34,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(25,31,37),ForeColor=Color.Gainsboro};
    void BuildTray(){var menu=new ContextMenuStrip();menu.Items.Add("Open",null,(_,_)=>ShowWindow());menu.Items.Add("Open website",null,(_,_)=>Process.Start(new ProcessStartInfo("https://hollowpoints.gg/first-blood"){UseShellExecute=true}));menu.Items.Add("Exit",null,(_,_)=>ExitApp());notify.Icon=Icon;notify.Text="First Blood Uploader";notify.Visible=true;notify.ContextMenuStrip=menu;notify.DoubleClick+=(_,_)=>ShowWindow();}
    void ShowWindow(){Show();WindowState=FormWindowState.Normal;Activate();}
    void HideToTray(){Hide();notify.ShowBalloonTip(1200,"First Blood Uploader","Still recording quietly in the system tray.",ToolTipIcon.Info);}
    void ExitApp(){exiting=true;notify.Visible=false;Close();}

    void StartWorker(){
        var exe=Path.Combine(appDir,"FirstBloodRecorder.exe");
        if(!File.Exists(exe)){SetStatus("Recorder missing",Color.IndianRed);AppendLog("FirstBloodRecorder.exe must be beside this app.");return;}
        worker=new Process { StartInfo=new ProcessStartInfo(exe){WorkingDirectory=appDir,Arguments=$"--config=\"{configFile}\"",UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8,CreateNoWindow=true},EnableRaisingEvents=true };
        worker.OutputDataReceived+=(_,e)=>{if(e.Data!=null)BeginInvoke(()=>HandleLine(e.Data));};worker.ErrorDataReceived+=(_,e)=>{if(e.Data!=null)BeginInvoke(()=>HandleLine(e.Data));};worker.Exited+=(_,_)=>BeginInvoke(()=>SetStatus("Stopped",Color.Gray));
        worker.Start();worker.BeginOutputReadLine();worker.BeginErrorReadLine();SetStatus("Checking League client",Color.Gray);
    }
    void StopWorker(){try{if(worker is {HasExited:false})worker.Kill(true);}catch{}notify.Dispose();}
    void HandleLine(string line){
        AppendLog(line); string? result=null;
        if(line.Contains("Uploaded match")){result="Success";uploadedCount++;}else if(line.Contains("Duplicate match")){result="Duplicate";duplicateCount++;}else if(line.Contains("Skipped unusable")){result="Cannot complete";skippedCount++;}else if(line.Contains("will retry")){failedCount++;}
        if(line.Contains("not registered"))SetStatus("Registration required",Color.IndianRed);else if(line.Contains("Open the League client"))SetStatus("League client not open",Color.Gray);else if(line.Contains("League detected")||line.Contains("Waiting for an ARAM")||line.Contains("not ARAM"))SetStatus("Idle — waiting for Mayhem",Color.Goldenrod);else if(line.Contains("Recording this")||line.Contains("First blood recorded"))SetStatus("Mayhem detected",Color.FromArgb(38,200,138));
        uploaded.Text=$"Success: {uploadedCount}";duplicates.Text=$"Duplicate: {duplicateCount}";skipped.Text=$"Cannot complete: {skippedCount}";failed.Text=$"Retry errors: {failedCount}";
        if(result!=null){var match=System.Text.RegularExpressions.Regex.Match(line,@"match\s+(\d+)",System.Text.RegularExpressions.RegexOptions.IgnoreCase);AddActivity(match.Success?match.Groups[1].Value:"Unknown",result);}
    }
    void LoadHistory(){
        var file=Path.Combine(configDir,"upload-state.json"); if(!File.Exists(file))return;
        try{using var doc=JsonDocument.Parse(File.ReadAllText(file));if(!doc.RootElement.TryGetProperty("matches",out var matches))return;
            var rows=new List<(long at,string id,string outcome)>();foreach(var match in matches.EnumerateObject()){var value=match.Value;var outcome=value.TryGetProperty("outcome",out var o)?o.GetString()??"Info":"Info";var at=value.TryGetProperty("syncedAt",out var t)?t.GetInt64():0;rows.Add((at,match.Name,outcome));if(outcome=="uploaded")uploadedCount++;else if(outcome=="duplicate")duplicateCount++;else if(outcome=="skipped")skippedCount++;}
            foreach(var row in rows.OrderByDescending(x=>x.at).Take(500)){var when=row.at>0?DateTimeOffset.FromUnixTimeMilliseconds(row.at).LocalDateTime.ToString("g"):"Earlier";var result=row.outcome=="uploaded"?"Success":row.outcome=="duplicate"?"Duplicate":"Cannot complete";AddActivity(row.id,result,when,false);}
            uploaded.Text=$"Success: {uploadedCount}";duplicates.Text=$"Duplicate: {duplicateCount}";skipped.Text=$"Cannot complete: {skippedCount}";
        }catch{}
    }
    void AddActivity(string matchId,string result,string? timestamp=null,bool insert=true){var item=new ListViewItem(timestamp??DateTime.Now.ToString("g"));item.SubItems.Add(matchId);item.SubItems.Add(result);item.ForeColor=result switch{"Success"=>Color.FromArgb(38,200,138),"Duplicate"=>Color.Gray,_=>Color.IndianRed};if(insert)activity.Items.Insert(0,item);else activity.Items.Add(item);while(activity.Items.Count>500)activity.Items.RemoveAt(activity.Items.Count-1);}
    void AppendLog(string line){try{File.AppendAllText(logFile,$"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {line}{Environment.NewLine}");}catch{}}
    void SetStatus(string text,Color color){state.Text=text;statusDot.BackColor=color;}

    async Task CheckForUpdates(Button button){
        button.Enabled=false;var previous=button.Text;button.Text="Checking…";
        try{var manager=new UpdateManager(new GithubSource(UpdateRepository,null,false));var update=await manager.CheckForUpdatesAsync();if(update==null){MessageBox.Show(this,"You already have the newest version.","First Blood Uploader");return;}button.Text="Downloading…";await manager.DownloadUpdatesAsync(update,progress=>BeginInvoke(()=>button.Text=$"Downloading… {progress}%"));StopWorkerOnly();notify.Visible=false;manager.ApplyUpdatesAndRestart(update);exiting=true;Close();}
        catch(Exception error){MessageBox.Show(this,$"Could not check for updates.\n\n{error.Message}","First Blood Uploader",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
        finally{if(!IsDisposed){button.Text=previous;button.Enabled=true;}}
    }

    void ShowLogs(){
        using var form=new Form{Text="First Blood Logs",ClientSize=new Size(760,460),StartPosition=FormStartPosition.CenterParent,BackColor=BackColor,ForeColor=ForeColor,Font=Font,Icon=Icon};
        var box=new TextBox{Dock=DockStyle.Fill,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,BackColor=Color.FromArgb(10,14,18),ForeColor=Color.Gainsboro,Font=new Font("Consolas",9),Text=File.Exists(logFile)?File.ReadAllText(logFile):"No log messages yet."};box.SelectionStart=box.TextLength;box.ScrollToCaret();form.Controls.Add(box);form.ShowDialog(this);
    }

    void OpenSettings(){
        RecorderConfig cfg; try{cfg=JsonSerializer.Deserialize<RecorderConfig>(File.ReadAllText(configFile),JsonOptions())??new();}catch{cfg=new();}
        cfg.installId=Guid.TryParse(cfg.installId,out _)?cfg.installId:Guid.NewGuid().ToString();cfg.deviceName=string.IsNullOrWhiteSpace(cfg.deviceName)?Environment.MachineName:cfg.deviceName;
        using var form=new Form{Text="First Blood Settings",ClientSize=new Size(540,390),StartPosition=FormStartPosition.CenterParent,BackColor=BackColor,ForeColor=ForeColor,Font=Font,Icon=Icon};
        var url=Field(form,"Website",cfg.serverUrl,25);var device=Field(form,"This PC's name",cfg.deviceName,85);var invite=Field(form,"Invite code",string.Empty,145,true);var league=Field(form,"League folder",cfg.leagueInstallPath,205);
        var registration=new Label{Text=string.IsNullOrWhiteSpace(cfg.deviceToken)?"Not registered — enter the invite code Alex gave you.":"Registered. Leave invite code blank to keep this credential.",Left=20,Top=260,Width=495,Height=38,ForeColor=string.IsNullOrWhiteSpace(cfg.deviceToken)?Color.Goldenrod:Color.FromArgb(38,200,138)};form.Controls.Add(registration);
        var save=ButtonFor(form,string.IsNullOrWhiteSpace(cfg.deviceToken)?"Register and save":"Save settings",320,280);
        save.Click+=async(_,_)=>{
            cfg.serverUrl=url.Text.Trim();cfg.deviceName=device.Text.Trim();cfg.leagueInstallPath=league.Text.Trim();cfg.localDataFile=string.IsNullOrWhiteSpace(cfg.localDataFile)?"data/matches.json":cfg.localDataFile;cfg.uploadStateFile="upload-state.json";
            if(string.IsNullOrWhiteSpace(cfg.serverUrl)||string.IsNullOrWhiteSpace(cfg.deviceName)){MessageBox.Show(form,"Enter the website and a name for this PC.","Missing information");return;}
            if(!string.IsNullOrWhiteSpace(invite.Text)){
                save.Enabled=false;registration.Text="Registering this PC…";
                try{using var client=new HttpClient{Timeout=TimeSpan.FromSeconds(20)};var response=await client.PostAsJsonAsync($"{cfg.serverUrl.TrimEnd('/')}/api/upload/register",new{inviteCode=invite.Text,installId=cfg.installId,deviceName=cfg.deviceName});var result=await response.Content.ReadFromJsonAsync<RegistrationResponse>(JsonOptions());if(!response.IsSuccessStatusCode||result?.ok!=true||string.IsNullOrWhiteSpace(result.deviceToken))throw new InvalidOperationException(result?.error??$"Registration failed ({(int)response.StatusCode})");cfg.deviceToken=result.deviceToken;cfg.uploadToken="";}
                catch(Exception error){registration.Text=error.Message;registration.ForeColor=Color.IndianRed;save.Enabled=true;return;}
            }
            if(string.IsNullOrWhiteSpace(cfg.deviceToken)&&string.IsNullOrWhiteSpace(cfg.uploadToken)){MessageBox.Show(form,"Enter an invite code to register this PC.","Registration required");save.Enabled=true;return;}
            Directory.CreateDirectory(configDir);File.WriteAllText(configFile,JsonSerializer.Serialize(cfg,JsonOptions()));StopWorkerOnly();StartWorker();form.Close();
        };form.ShowDialog(this);
    }
    TextBox Field(Form f,string label,string value,int top,bool password=false){f.Controls.Add(new Label{Text=label,Left=20,Top=top,Width=140});var box=new TextBox{Text=value,Left=165,Top=top-3,Width=320,UseSystemPasswordChar=password};f.Controls.Add(box);return box;}
    Button ButtonFor(Form f,string text,int top,int left){var b=new Button{Text=text,Top=top,Left=left,Width=235,Height=38,FlatStyle=FlatStyle.Flat};f.Controls.Add(b);return b;}
    void StopWorkerOnly(){try{if(worker is {HasExited:false})worker.Kill(true);}catch{}}
    bool NeedsRegistration(){try{var cfg=JsonSerializer.Deserialize<RecorderConfig>(File.ReadAllText(configFile),JsonOptions());return string.IsNullOrWhiteSpace(cfg?.deviceToken)&&string.IsNullOrWhiteSpace(cfg?.uploadToken);}catch{return true;}}
    void MigrateLegacyFiles(){
        void Copy(string relative){var source=Path.Combine(appDir,relative);var target=Path.Combine(configDir,relative);if(!File.Exists(source)||File.Exists(target))return;Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Copy(source,target);}
        Copy("recorder.config.json");Copy("uploader-ui.json");Copy("uploader.log");Copy("upload-state.json");Copy(Path.Combine("data","matches.json"));
    }
    UiSettings LoadSettings(){try{return JsonSerializer.Deserialize<UiSettings>(File.ReadAllText(uiFile),JsonOptions())??new();}catch{return new();}}
    void SaveSettings()=>File.WriteAllText(uiFile,JsonSerializer.Serialize(settings,JsonOptions()));
    void ApplyStartup(){using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true);if(settings.StartWithWindows)key?.SetValue("FirstBloodUploader",$"\"{Application.ExecutablePath}\"");else key?.DeleteValue("FirstBloodUploader",false);}
    static JsonSerializerOptions JsonOptions()=>new(){PropertyNameCaseInsensitive=true,WriteIndented=true};
    static Icon LoadAppIcon(){using var stream=typeof(MainForm).Assembly.GetManifestResourceStream("FirstBloodUploader.Assets.first-blood.ico");return stream==null?SystemIcons.Application:(Icon)new Icon(stream).Clone();}
    static Image? LoadBanner(){using var stream=typeof(MainForm).Assembly.GetManifestResourceStream("FirstBloodUploader.Assets.uploader-banner.png");return stream==null?null:new Bitmap(Image.FromStream(stream));}
}

sealed class RecorderConfig {
    public string serverUrl {get;set;}="https://hollowpoints.gg"; public string deviceToken {get;set;}=""; public string uploadToken {get;set;}=""; public string installId {get;set;}=""; public string deviceName {get;set;}=""; public string leagueInstallPath {get;set;}=@"C:\Riot Games\League of Legends"; public string localDataFile {get;set;}="data/matches.json"; public string uploadStateFile {get;set;}="upload-state.json"; public int pollIntervalMs {get;set;}=2000; public int uploadIntervalMs {get;set;}=15000;
}

sealed class RegistrationResponse { public bool ok {get;set;} public string? deviceToken {get;set;} public string? error {get;set;} }
