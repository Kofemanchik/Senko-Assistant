using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace SenkoSetup
{
    // Свой установщик: окно рисуем сами, а сами файлы ставит обычный установщик электрона (NSIS), который лежит внутри exe.
    // Так остаются теми же папка, ярлыки, запись в «Приложения» и автообновление.
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var win = new SetupWindow(args);
            return app.Run(win.Window);
        }
    }

    public class SetupWindow
    {
        public Window Window;
        T F<T>(string n) where T : class { return Window.FindName(n) as T; }
        readonly string[] _args;
        string _dir;
        Process _proc;
        string _payload;
        DispatcherTimer _tick;
        double _shown, _target;
        long _expected;
        DateTime _t0;
        bool _busy;

        static readonly string AppExe = "Senko Assistant.exe";

        public SetupWindow(string[] args)
        {
            _args = args;
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("SenkoSetup.Ui.layout"))
                Window = (Window)XamlReader.Load(s);
            using (var s = asm.GetManifestResourceStream("SenkoSetup.Assets.fox.png"))
            {
                var bi = new BitmapImage();
                bi.BeginInit(); bi.StreamSource = s; bi.CacheOption = BitmapCacheOption.OnLoad; bi.EndInit(); bi.Freeze();
                F<Image>("Fox").Source = bi;
            }
            using (var s = asm.GetManifestResourceStream("SenkoSetup.expected.txt"))
            {
                long v = 0;
                if (s != null) using (var r = new StreamReader(s)) long.TryParse(r.ReadToEnd().Trim(), out v);
                _expected = v > 0 ? v : 420L * 1024 * 1024;
            }
            _dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Senko Assistant");
            F<TextBlock>("DirText").Text = _dir;
            using (var s = asm.GetManifestResourceStream("SenkoSetup.Assets.banner.png"))
            {
                var bb = new BitmapImage();
                bb.BeginInit(); bb.StreamSource = s; bb.CacheOption = BitmapCacheOption.OnLoad; bb.EndInit(); bb.Freeze();
                F<Border>("Hero").Background = new ImageBrush(bb) { Stretch = Stretch.UniformToFill };
            }

            F<Grid>("TitleBar").MouseLeftButtonDown += (s, e) => { if (e.ButtonState == MouseButtonState.Pressed) Window.DragMove(); };
            F<Button>("BtnMin").Click += (s, e) => Window.WindowState = WindowState.Minimized;
            F<Button>("BtnClose").Click += (s, e) => TryClose();
            F<Button>("BtnErrClose").Click += (s, e) => Window.Close();
            F<Button>("BtnFinish").Click += (s, e) => Finish();
            F<Button>("BtnRetry").Click += (s, e) => Start();
            F<Button>("BtnInstall").Click += (s, e) => Start();
            F<Button>("BtnBrowse").Click += (s, e) => Browse();
            Window.Opacity = 0;
            Window.Loaded += (s, e) => Intro();
        }

        // --- оформление ---
        void Intro()
        {
            Window.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(320)));
            var sc = (ScaleTransform)F<Border>("Hero").RenderTransform;
            var zoom = new DoubleAnimation(1.06, 1, TimeSpan.FromMilliseconds(1400)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
            sc.BeginAnimation(ScaleTransform.ScaleXProperty, zoom);
            sc.BeginAnimation(ScaleTransform.ScaleYProperty, zoom);
            Slide(F<FrameworkElement>("PageWelcome"));
        }

        void Slide(FrameworkElement page)
        {
            page.Visibility = Visibility.Visible;
            page.Opacity = 0;
            var tr = page.RenderTransform as TranslateTransform;
            page.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(380)));
            if (tr != null) tr.BeginAnimation(TranslateTransform.XProperty,
                new DoubleAnimation(36, 0, TimeSpan.FromMilliseconds(420)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
        }

        void Show(string name)
        {
            foreach (var n in new[] { "PageWelcome", "PageProgress", "PageDone", "PageError" })
                F<FrameworkElement>(n).Visibility = n == name ? Visibility.Visible : Visibility.Collapsed;
            Slide(F<FrameworkElement>(name));
        }

        void Browse()
        {
            using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = "Папка для Senko Assistant", SelectedPath = Directory.Exists(Path.GetDirectoryName(_dir)) ? Path.GetDirectoryName(_dir) : "" })
            {
                if (d.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
                var p = d.SelectedPath;
                _dir = Path.GetFileName(p).StartsWith("Senko", StringComparison.OrdinalIgnoreCase) ? p : Path.Combine(p, "Senko Assistant");
                F<TextBlock>("DirText").Text = _dir;
            }
        }

        // --- установка ---
        void Start()
        {
            if (_busy) return;
            try
            {
                if (KillRunning()) Thread.Sleep(600);
                _payload = Path.Combine(Path.GetTempPath(), "senko-payload-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("SenkoSetup.payload.exe"))
                {
                    if (s == null) { Fail("В установщике нет файлов программы (сборка без пакета).", null); return; }
                    using (var f = File.Create(_payload)) s.CopyTo(f);
                }
                Directory.CreateDirectory(Path.GetDirectoryName(_dir));
                // /D= должен быть последним и без кавычек (правило NSIS)
                _proc = Process.Start(new ProcessStartInfo(_payload, "/S /currentuser /D=" + _dir) { UseShellExecute = false, CreateNoWindow = true });
            }
            catch (Exception ex) { Fail("Не получилось запустить установку.", ex.Message); return; }
            _busy = true; _shown = 0; _target = 0; _t0 = DateTime.Now;
            Show("PageProgress");
            _tick = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(60) };
            _tick.Tick += (s, e) => Tick();
            _tick.Start();
        }

        bool KillRunning()
        {
            bool any = false;
            foreach (var p in Process.GetProcessesByName("Senko Assistant"))
            {
                try { p.Kill(); p.WaitForExit(3000); any = true; } catch { }
            }
            return any;
        }

        static long DirSize(string d)
        {
            long n = 0;
            try { foreach (var f in new DirectoryInfo(d).EnumerateFiles("*", SearchOption.AllDirectories)) n += f.Length; } catch { }
            return n;
        }

        int _poll;
        void Tick()
        {
            if (_proc == null) return;
            if (++_poll % 8 == 1 && Directory.Exists(_dir))
                _target = Math.Min(96, DirSize(_dir) * 100.0 / _expected);
            var secs = (DateTime.Now - _t0).TotalSeconds;
            _target = Math.Max(_target, Math.Min(12, secs * 1.5)); // сразу видно движение, даже пока файлы не пошли
            if (_proc.HasExited)
            {
                if (_proc.ExitCode != 0) { _tick.Stop(); Fail("Установка завершилась с кодом " + _proc.ExitCode + ".", null); return; }
                if (!File.Exists(Path.Combine(_dir, AppExe))) { _tick.Stop(); Fail("Установка закончилась, но файл программы не найден.", _dir); return; }
                _target = 100;
            }
            _shown += (_target - _shown) * 0.12 + (_target > _shown ? 0.04 : 0);
            if (_shown > _target) _shown = _target;
            var w = F<Border>("BarTrack").ActualWidth * _shown / 100;
            F<Border>("BarFill").Width = Math.Max(0, w);
            F<TextBlock>("Pct").Text = ((int)Math.Round(_shown)) + "%";
            F<TextBlock>("Status").Text = _shown < 30 ? "Распаковываем файлы…" : _shown < 85 ? "Копируем программу…" : _shown < 100 ? "Создаём ярлыки…" : "Готово";
            if (_proc.HasExited && _shown >= 99.5) { _tick.Stop(); Done(); }
        }

        void Done()
        {
            _busy = false;
            try
            {
                if (F<CheckBox>("ChkDesktop").IsChecked != true)
                {
                    var lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Senko Assistant.lnk");
                    if (File.Exists(lnk)) File.Delete(lnk);
                }
            }
            catch { }
            try { File.Delete(_payload); } catch { }
            Show("PageDone");
        }

        void Fail(string text, string detail)
        {
            _busy = false;
            F<TextBlock>("ErrText").Text = text;
            F<TextBlock>("ErrLog").Text = detail ?? "";
            Show("PageError");
        }

        void Finish()
        {
            if (F<CheckBox>("ChkLaunch").IsChecked == true)
            {
                try { Process.Start(new ProcessStartInfo(Path.Combine(_dir, AppExe)) { UseShellExecute = true, WorkingDirectory = _dir }); } catch { }
            }
            Window.Close();
        }

        void TryClose()
        {
            if (_busy) { if (MessageBox.Show("Идёт установка. Прервать?", "Senko Assistant", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return; try { _proc.Kill(); } catch { } }
            Window.Close();
        }
    }
}
